/**
 * Rollbook API — Cloudflare Worker
 * 정적 화면은 public/ 자산으로 서빙되고, /api/* 만 여기서 처리한다.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const err = (message, status = 400) => json({ error: message }, status);

// 테이블이 없으면 만들어 둔다 (마이그레이션을 깜빡해도 동작하도록)
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      dept TEXT NOT NULL DEFAULT '',
      code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      sheet_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(sheet_id, member_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
  ]);
  // 기존 DB 에 직함 컬럼이 없으면 추가
  try {
    await db.prepare("ALTER TABLE members ADD COLUMN title TEXT NOT NULL DEFAULT ''").run();
  } catch {
    /* 이미 있으면 무시 */
  }
  schemaReady = true;
}

// 회원 QR 코드 값: RB- + 랜덤 12자리
function newMemberCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `RB-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      await ensureSchema(env.DB);
      const res = await route(request, env, pathname);
      return res ?? err('찾을 수 없는 API 경로입니다.', 404);
    } catch (e) {
      return err(`서버 오류: ${e.message}`, 500);
    }
  },
};

async function route(request, env, pathname) {
  const db = env.DB;
  const method = request.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  // ── 브랜드 로고 (D1 저장, 없으면 기본 SVG) ───────────
  if (pathname === '/api/logo') {
    if (method === 'GET') {
      const row = await db.prepare("SELECT value FROM settings WHERE key = 'brand_logo'").first();
      const m = row?.value?.match(/^data:([^;,]+);base64,(.+)$/s);
      if (m) {
        const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
        return new Response(bin, {
          headers: { 'content-type': m[1], 'cache-control': 'no-store' },
        });
      }
      const fallback = await env.ASSETS.fetch(new URL('/bdo-logo.png', request.url));
      const headers = new Headers(fallback.headers);
      headers.set('cache-control', 'no-store');
      return new Response(fallback.body, { status: fallback.status, headers });
    }
    if (method === 'POST') {
      const body = await readBody(request);
      const dataUrl = body?.dataUrl ?? '';
      if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
        return err('이미지 파일(data URL)만 저장할 수 있습니다.');
      }
      if (dataUrl.length > 2_000_000) return err('로고 파일이 너무 큽니다. 1MB 이하로 올려 주세요.');
      await db
        .prepare("INSERT INTO settings (key, value) VALUES ('brand_logo', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(dataUrl)
        .run();
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.prepare("DELETE FROM settings WHERE key = 'brand_logo'").run();
      return json({ ok: true });
    }
  }

  // ── 상태 ──────────────────────────────────────────────
  if (pathname === '/api/status' && method === 'GET') {
    const active = await db
      .prepare('SELECT id, title, sheet_date FROM sheets WHERE is_active = 1 LIMIT 1')
      .first();
    return json({ activeSheet: active ?? null });
  }

  // ── 스캐너 우측 출석부 패널: 활성 출석부의 최근 기록 ──
  if (pathname === '/api/recent' && method === 'GET') {
    const sheet = await db
      .prepare('SELECT id, title, sheet_date FROM sheets WHERE is_active = 1 LIMIT 1')
      .first();
    if (!sheet) return json({ sheet: null, entries: [], attended: 0, total: 0 });
    const { results: entries } = await db
      .prepare(`
        SELECT m.name, m.title, m.dept, a.checked_at
        FROM attendance a JOIN members m ON m.id = a.member_id
        WHERE a.sheet_id = ?
        ORDER BY a.checked_at DESC
        LIMIT 30
      `)
      .bind(sheet.id)
      .all();
    const attended = await db
      .prepare('SELECT COUNT(*) AS n FROM attendance WHERE sheet_id = ?')
      .bind(sheet.id)
      .first();
    const total = await db.prepare('SELECT COUNT(*) AS n FROM members').first();
    return json({ sheet, entries, attended: attended?.n ?? 0, total: total?.n ?? 0 });
  }

  // ── 출석 체크 (스캐너) ────────────────────────────────
  if (pathname === '/api/checkin' && method === 'POST') {
    const body = await readBody(request);
    let code = (body?.code ?? '').trim();
    if (!code) return err('QR 코드 값이 비어 있습니다.');
    if (code.startsWith('ROLLBOOK:')) code = code.slice('ROLLBOOK:'.length);

    const member = await db
      .prepare('SELECT id, name, title, dept FROM members WHERE code = ?')
      .bind(code)
      .first();
    if (!member) return json({ status: 'unknown' }, 404);

    const sheet = await db
      .prepare('SELECT id, title, sheet_date FROM sheets WHERE is_active = 1 LIMIT 1')
      .first();
    if (!sheet) return json({ status: 'no_sheet' }, 409);

    const existing = await db
      .prepare('SELECT checked_at FROM attendance WHERE sheet_id = ? AND member_id = ?')
      .bind(sheet.id, member.id)
      .first();
    if (existing) {
      return json({
        status: 'already',
        member: { name: member.name, title: member.title, dept: member.dept },
        sheet: { title: sheet.title },
        checked_at: existing.checked_at,
      });
    }

    const checkedAt = new Date().toISOString();
    await db
      .prepare('INSERT INTO attendance (sheet_id, member_id, checked_at) VALUES (?, ?, ?)')
      .bind(sheet.id, member.id, checkedAt)
      .run();
    return json({
      status: 'ok',
      member: { name: member.name, title: member.title, dept: member.dept },
      sheet: { title: sheet.title },
      checked_at: checkedAt,
    });
  }

  // ── 명단 (members) ────────────────────────────────────
  if (pathname === '/api/members' && method === 'GET') {
    const { results } = await db
      .prepare('SELECT id, name, title, dept, code, created_at FROM members ORDER BY name, id')
      .all();
    return json({ members: results });
  }

  if (pathname === '/api/members' && method === 'POST') {
    const body = await readBody(request);
    const name = (body?.name ?? '').trim();
    const title = (body?.title ?? '').trim();
    const dept = (body?.dept ?? '').trim();
    if (!name) return err('이름을 입력해 주세요.');

    // 코드 충돌 시 몇 번 재시도
    for (let i = 0; i < 5; i++) {
      try {
        const code = newMemberCode();
        const r = await db
          .prepare('INSERT INTO members (name, title, dept, code) VALUES (?, ?, ?, ?)')
          .bind(name, title, dept, code)
          .run();
        const member = await db
          .prepare('SELECT id, name, title, dept, code, created_at FROM members WHERE id = ?')
          .bind(r.meta.last_row_id)
          .first();
        return json({ member }, 201);
      } catch (e) {
        if (!String(e.message).includes('UNIQUE')) throw e;
      }
    }
    return err('코드 생성에 실패했습니다. 다시 시도해 주세요.', 500);
  }

  // 엑셀 업로드 일괄 등록 — 같은 이름+부서가 이미 있으면 건너뜀
  if (pathname === '/api/members/bulk' && method === 'POST') {
    const body = await readBody(request);
    const list = Array.isArray(body?.members) ? body.members : [];
    if (!list.length) return err('등록할 인원이 없습니다.');
    if (list.length > 1000) return err('한 번에 1,000명까지 등록할 수 있습니다.');

    const { results: existing } = await db.prepare('SELECT name, dept FROM members').all();
    const seen = new Set(existing.map((m) => `${m.name}|${m.dept}`));
    const stmts = [];
    let added = 0;
    let skipped = 0;
    for (const m of list) {
      const name = String(m?.name ?? '').trim();
      const title = String(m?.title ?? '').trim();
      const dept = String(m?.dept ?? '').trim();
      if (!name) { skipped++; continue; }
      const key = `${name}|${dept}`;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      stmts.push(db.prepare('INSERT INTO members (name, title, dept, code) VALUES (?, ?, ?, ?)').bind(name, title, dept, newMemberCode()));
      added++;
    }
    if (stmts.length) await db.batch(stmts);
    return json({ added, skipped });
  }

  if (seg[1] === 'members' && seg.length === 3) {
    const id = Number(seg[2]);
    if (!Number.isInteger(id)) return err('잘못된 ID 입니다.');

    if (method === 'PUT') {
      const body = await readBody(request);
      const name = (body?.name ?? '').trim();
      const title = (body?.title ?? '').trim();
      const dept = (body?.dept ?? '').trim();
      if (!name) return err('이름을 입력해 주세요.');
      await db.prepare('UPDATE members SET name = ?, title = ?, dept = ? WHERE id = ?').bind(name, title, dept, id).run();
      const member = await db
        .prepare('SELECT id, name, title, dept, code, created_at FROM members WHERE id = ?')
        .bind(id)
        .first();
      return member ? json({ member }) : err('회원을 찾을 수 없습니다.', 404);
    }

    if (method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM attendance WHERE member_id = ?').bind(id),
        db.prepare('DELETE FROM members WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  // ── 출석부 (sheets) ───────────────────────────────────
  if (pathname === '/api/sheets' && method === 'GET') {
    const { results } = await db
      .prepare(`
        SELECT s.id, s.title, s.sheet_date, s.is_active, s.created_at,
               (SELECT COUNT(*) FROM attendance a WHERE a.sheet_id = s.id) AS attended
        FROM sheets s
        ORDER BY s.sheet_date DESC, s.id DESC
      `)
      .all();
    const total = await db.prepare('SELECT COUNT(*) AS n FROM members').first();
    return json({ sheets: results, memberCount: total?.n ?? 0 });
  }

  if (pathname === '/api/sheets' && method === 'POST') {
    const body = await readBody(request);
    const title = (body?.title ?? '').trim();
    const sheetDate = (body?.sheet_date ?? '').trim();
    const activate = Boolean(body?.activate);
    if (!title) return err('출석부 이름을 입력해 주세요.');
    if (!sheetDate) return err('날짜를 선택해 주세요.');

    const r = await db
      .prepare('INSERT INTO sheets (title, sheet_date, is_active) VALUES (?, ?, 0)')
      .bind(title, sheetDate)
      .run();
    const id = r.meta.last_row_id;
    if (activate) {
      await db.batch([
        db.prepare('UPDATE sheets SET is_active = 0 WHERE is_active = 1'),
        db.prepare('UPDATE sheets SET is_active = 1 WHERE id = ?').bind(id),
      ]);
    }
    const sheet = await db.prepare('SELECT * FROM sheets WHERE id = ?').bind(id).first();
    return json({ sheet }, 201);
  }

  if (seg[1] === 'sheets' && seg.length >= 3) {
    const id = Number(seg[2]);
    if (!Number.isInteger(id)) return err('잘못된 ID 입니다.');

    // 출석 현황 (명단 전체 + 체크 여부)
    if (seg.length === 3 && method === 'GET') {
      const sheet = await db.prepare('SELECT * FROM sheets WHERE id = ?').bind(id).first();
      if (!sheet) return err('출석부를 찾을 수 없습니다.', 404);
      const { results } = await db
        .prepare(`
          SELECT m.id AS member_id, m.name, m.title, m.dept, a.checked_at
          FROM members m
          LEFT JOIN attendance a ON a.member_id = m.id AND a.sheet_id = ?
          ORDER BY m.name, m.id
        `)
        .bind(id)
        .all();
      return json({ sheet, rows: results });
    }

    if (seg.length === 3 && method === 'PUT') {
      const body = await readBody(request);
      const title = (body?.title ?? '').trim();
      const sheetDate = (body?.sheet_date ?? '').trim();
      if (!title) return err('출석부 이름을 입력해 주세요.');
      if (!sheetDate) return err('날짜를 선택해 주세요.');
      await db
        .prepare('UPDATE sheets SET title = ?, sheet_date = ? WHERE id = ?')
        .bind(title, sheetDate, id)
        .run();
      const sheet = await db.prepare('SELECT * FROM sheets WHERE id = ?').bind(id).first();
      return sheet ? json({ sheet }) : err('출석부를 찾을 수 없습니다.', 404);
    }

    if (seg.length === 3 && method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM attendance WHERE sheet_id = ?').bind(id),
        db.prepare('DELETE FROM sheets WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }

    // 사용(활성화) — 스캐너가 이 출석부에 기록한다
    if (seg[3] === 'activate' && method === 'POST') {
      const sheet = await db.prepare('SELECT id FROM sheets WHERE id = ?').bind(id).first();
      if (!sheet) return err('출석부를 찾을 수 없습니다.', 404);
      await db.batch([
        db.prepare('UPDATE sheets SET is_active = 0 WHERE is_active = 1'),
        db.prepare('UPDATE sheets SET is_active = 1 WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }

    // 사용 해제
    if (seg[3] === 'deactivate' && method === 'POST') {
      await db.prepare('UPDATE sheets SET is_active = 0 WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    // 수동 출석 편집 (관리자)
    if (seg[3] === 'mark' && method === 'POST') {
      const body = await readBody(request);
      const memberId = Number(body?.member_id);
      const present = Boolean(body?.present);
      if (!Number.isInteger(memberId)) return err('잘못된 회원 ID 입니다.');
      if (present) {
        await db
          .prepare(`
            INSERT INTO attendance (sheet_id, member_id, checked_at) VALUES (?, ?, ?)
            ON CONFLICT(sheet_id, member_id) DO NOTHING
          `)
          .bind(id, memberId, new Date().toISOString())
          .run();
      } else {
        await db
          .prepare('DELETE FROM attendance WHERE sheet_id = ? AND member_id = ?')
          .bind(id, memberId)
          .run();
      }
      return json({ ok: true });
    }
  }

  return null;
}
