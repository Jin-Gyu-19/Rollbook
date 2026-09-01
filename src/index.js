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
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL
    )`),
  ]);
  // 기존 DB 에 직함 컬럼이 없으면 추가
  try {
    await db.prepare("ALTER TABLE members ADD COLUMN title TEXT NOT NULL DEFAULT ''").run();
  } catch {
    /* 이미 있으면 무시 */
  }

  // 테스트용 인원 5명 자동 등록 (DB당 1회만 — 명단에서 삭제해도 다시 생기지 않음)
  const seeded = await db.prepare("SELECT value FROM settings WHERE key = 'seeded_test'").first();
  if (!seeded) {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO members (name, title, dept, code) VALUES
        ('김민준', '사원', '감사1본부', 'RB-TEST-0001'),
        ('이서연', '대리', '감사1본부', 'RB-TEST-0002'),
        ('박지훈', '과장', '디지털본부', 'RB-TEST-0003'),
        ('최수아', 'MANAGER', '세무본부', 'RB-TEST-0004'),
        ('정도윤', '파트너', '어드바이저리', 'RB-TEST-0005')`),
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded_test', '1')"),
    ]);
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

// ── 인증 ──────────────────────────────────────────────
const SESSION_COOKIE = 'rb_sess';

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

// PBKDF2-SHA256 해시 — "pbkdf2$반복수$salt$hash" 형태로 저장
async function hashPassword(password, saltB64 = null, iterations = 100000) {
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${toB64(salt)}$${toB64(bits)}`;
}

async function verifyPassword(password, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 4) return false;
  return (await hashPassword(password, parts[2], Number(parts[1]))) === stored;
}

async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row?.value ?? null;
}

async function setSetting(db, key, value) {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

async function getSession(db, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const row = await db.prepare('SELECT role, expires_at FROM sessions WHERE token = ?').bind(token).first();
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }
  return { role: row.role, token };
}

// 관리자 30일 · 스캐너 PC 1년 유지
async function createSession(db, role, request) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const days = role === 'admin' ? 30 : 365;
  const expires = new Date(Date.now() + days * 86400_000).toISOString();
  await db.prepare('INSERT INTO sessions (token, role, expires_at) VALUES (?, ?, ?)').bind(token, role, expires).run();
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`;
}

const jsonWithCookie = (data, cookie) =>
  new Response(JSON.stringify(data), { headers: { ...JSON_HEADERS, 'set-cookie': cookie } });

// 경로별 필요한 권한: null = 공개, 'scanner' = 스캐너 코드 이상, 'admin' = 관리자만
function requiredRole(pathname, method) {
  if (pathname === '/login' || pathname === '/login.html') return null;
  if (pathname === '/app.css' || pathname === '/bdo-design.css' || pathname === '/bdo-logo.png' || pathname === '/favicon.ico') return null;
  if (pathname.startsWith('/vendor/')) return null;
  if (pathname === '/api/logo' && method === 'GET') return null;
  if (pathname.startsWith('/api/auth/')) return null;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/scanner.js') return 'scanner';
  if (pathname === '/api/status' || pathname === '/api/recent' || pathname === '/api/checkin') return 'scanner';
  return 'admin';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      await ensureSchema(env.DB);

      // 접속 권한 검사 — 페이지는 로그인 화면으로, API 는 401 로
      const need = requiredRole(pathname, request.method);
      if (need) {
        const session = await getSession(env.DB, request);
        const allowed = session && (session.role === 'admin' || (need === 'scanner' && session.role === 'scanner'));
        if (!allowed) {
          if (pathname.startsWith('/api/')) return json({ error: '로그인이 필요합니다.', auth: true }, 401);
          return Response.redirect(new URL(`/login?next=${encodeURIComponent(pathname)}`, request.url).toString(), 302);
        }
      }

      if (!pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      const res = await route(request, env, pathname);
      return res ?? err('찾을 수 없는 API 경로입니다.', 404);
    } catch (e) {
      // 오류가 나도 공개 자산(로그인 화면·CSS 등)은 열리고, 보호 자산은 열리지 않는다
      if (!pathname.startsWith('/api/') && requiredRole(pathname, request.method) === null) {
        return env.ASSETS.fetch(request);
      }
      return err(`서버 오류: ${e.message}`, 500);
    }
  },
};

async function route(request, env, pathname) {
  const db = env.DB;
  const method = request.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  // ── 인증 API ──────────────────────────────────────────
  // 현재 상태: 초기 설정 여부 + 내 로그인 역할
  if (pathname === '/api/auth/state' && method === 'GET') {
    const hasAdmin = Boolean(await getSetting(db, 'admin_pw'));
    const session = await getSession(db, request);
    return json({ setup: hasAdmin, role: session?.role ?? null });
  }

  // 최초 1회: 관리자 비밀번호 만들기 (이미 있으면 거부)
  if (pathname === '/api/auth/setup' && method === 'POST') {
    if (await getSetting(db, 'admin_pw')) return err('이미 관리자 비밀번호가 설정되어 있습니다.', 409);
    const body = await readBody(request);
    const password = String(body?.password ?? '');
    if (password.length < 4) return err('비밀번호는 4자 이상으로 해 주세요.');
    await setSetting(db, 'admin_pw', await hashPassword(password));
    const cookie = await createSession(db, 'admin', request);
    return jsonWithCookie({ ok: true, role: 'admin' }, cookie);
  }

  // 로그인 — 관리자 비밀번호면 admin, 스캐너 접속 코드면 scanner
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(request);
    const password = String(body?.password ?? '');
    if (!password) return err('비밀번호를 입력해 주세요.');
    let role = null;
    const adminHash = await getSetting(db, 'admin_pw');
    if (adminHash && (await verifyPassword(password, adminHash))) role = 'admin';
    if (!role) {
      const scannerCode = await getSetting(db, 'scanner_code');
      if (scannerCode && password === scannerCode) role = 'scanner';
    }
    if (!role) return err('비밀번호가 올바르지 않습니다.', 401);
    await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
    const cookie = await createSession(db, role, request);
    return jsonWithCookie({ ok: true, role }, cookie);
  }

  // 로그아웃
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const session = await getSession(db, request);
    if (session) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(session.token).run();
    return jsonWithCookie({ ok: true }, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  // 관리자 비밀번호 변경 (관리자만)
  if (pathname === '/api/auth/password' && method === 'POST') {
    const session = await getSession(db, request);
    if (session?.role !== 'admin') return json({ error: '로그인이 필요합니다.', auth: true }, 401);
    const body = await readBody(request);
    const current = String(body?.current ?? '');
    const next = String(body?.next ?? '');
    const adminHash = await getSetting(db, 'admin_pw');
    if (!(await verifyPassword(current, adminHash))) return err('현재 비밀번호가 올바르지 않습니다.', 401);
    if (next.length < 4) return err('새 비밀번호는 4자 이상으로 해 주세요.');
    await setSetting(db, 'admin_pw', await hashPassword(next));
    // 다른 기기의 관리자 세션은 정리하고 내 세션만 남긴다
    await db.prepare("DELETE FROM sessions WHERE role = 'admin' AND token != ?").bind(session.token).run();
    return json({ ok: true });
  }

  // 스캐너 접속 코드 보기/설정/해제 (관리자만)
  if (pathname === '/api/auth/scanner-code') {
    const session = await getSession(db, request);
    if (session?.role !== 'admin') return json({ error: '로그인이 필요합니다.', auth: true }, 401);
    if (method === 'GET') {
      return json({ code: (await getSetting(db, 'scanner_code')) ?? '' });
    }
    if (method === 'POST') {
      const body = await readBody(request);
      const code = String(body?.code ?? '').trim();
      if (!code) {
        await db.prepare("DELETE FROM settings WHERE key = 'scanner_code'").run();
        await db.prepare("DELETE FROM sessions WHERE role = 'scanner'").run();
        return json({ ok: true, code: '' });
      }
      if (code.length < 4) return err('접속 코드는 4자 이상으로 해 주세요.');
      await setSetting(db, 'scanner_code', code);
      return json({ ok: true, code });
    }
  }

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
