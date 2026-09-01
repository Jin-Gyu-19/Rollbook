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
    db.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
      client TEXT PRIMARY KEY,
      fails INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    )`),
  ]);
  // 기존 DB 에 없는 컬럼은 추가
  try {
    await db.prepare("ALTER TABLE members ADD COLUMN title TEXT NOT NULL DEFAULT ''").run();
  } catch {
    /* 이미 있으면 무시 */
  }
  try {
    await db.prepare('ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0').run();
  } catch {
    /* 이미 있으면 무시 */
  }
  try {
    await db.prepare('ALTER TABLE members ADD COLUMN login_token TEXT').run();
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

  // 김진규를 관리자로 지정 (DB당 1회 — 명단에 있으면 지정, 없으면 새로 등록)
  const adminSeeded = await db.prepare("SELECT value FROM settings WHERE key = 'seeded_admin_kimjinkyu'").first();
  if (!adminSeeded) {
    const existing = await db.prepare("SELECT id FROM members WHERE name = '김진규' ORDER BY id LIMIT 1").first();
    if (existing) {
      await db
        .prepare('UPDATE members SET is_admin = 1, login_token = COALESCE(login_token, ?) WHERE id = ?')
        .bind(newLoginToken(), existing.id)
        .run();
    } else {
      await db
        .prepare("INSERT INTO members (name, title, dept, code, is_admin, login_token) VALUES ('김진규', '', '', ?, 1, ?)")
        .bind(newMemberCode(), newLoginToken())
        .run();
    }
    await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded_admin_kimjinkyu', '1')").run();
  }

  // 스캐너 PC 로그인 QR 토큰 (없으면 발급)
  const scannerToken = await db.prepare("SELECT value FROM settings WHERE key = 'scanner_token'").first();
  if (!scannerToken) {
    await db
      .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('scanner_token', ?)")
      .bind(newScannerToken())
      .run();
  }

  // 비밀번호·접속코드 로그인은 QR 로그인으로 대체 — 남아 있던 값 정리
  await db.prepare("DELETE FROM settings WHERE key IN ('admin_pw', 'scanner_code')").run();

  // 예전 방식(비밀번호·접속코드)으로 만들어진 세션은 한 번 모두 끊는다.
  // 이걸 안 하면 업데이트 후에도 예전 쿠키로 로그인 화면 없이 들어가진다.
  const purged = await db.prepare("SELECT value FROM settings WHERE key = 'auth_qr_only_purged'").first();
  if (!purged) {
    await db.batch([
      db.prepare('DELETE FROM sessions'),
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('auth_qr_only_purged', '1')"),
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

// 로그인 전용 QR 토큰 (출석용 QR 과 별개 — 명찰 QR 이 노출돼도 로그인은 안 됨)
function randomToken(prefix, len = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of bytes) out += alphabet[b % 32];
  return `${prefix}-${out}`;
}

const newLoginToken = () => randomToken('RBL');
const newScannerToken = () => randomToken('RBS');
const newRecoveryCode = () => randomToken('RBR', 16);

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

// ── 로그인 실패 잠금 (5회 틀리면 10분) ────────────────
const MAX_FAILS = 5;
const LOCK_MINUTES = 10;

const clientKey = (request) =>
  request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';

// 잠겨 있으면 남은 시간(분)을, 아니면 null 을 돌려준다
async function lockRemaining(db, request) {
  const row = await db.prepare('SELECT locked_until FROM login_attempts WHERE client = ?').bind(clientKey(request)).first();
  if (!row?.locked_until) return null;
  const left = new Date(row.locked_until).getTime() - Date.now();
  if (left <= 0) return null;
  return Math.max(1, Math.ceil(left / 60000));
}

// 실패 1회 기록 — 5회째면 잠근다. { fails, lockedMinutes } 반환
async function recordFail(db, request) {
  const client = clientKey(request);
  await db
    .prepare(`
      INSERT INTO login_attempts (client, fails) VALUES (?, 1)
      ON CONFLICT(client) DO UPDATE SET fails = fails + 1
    `)
    .bind(client)
    .run();
  const row = await db.prepare('SELECT fails FROM login_attempts WHERE client = ?').bind(client).first();
  const fails = row?.fails ?? 1;
  if (fails >= MAX_FAILS) {
    const until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
    await db.prepare('UPDATE login_attempts SET fails = 0, locked_until = ? WHERE client = ?').bind(until, client).run();
    return { fails, lockedMinutes: LOCK_MINUTES };
  }
  return { fails, lockedMinutes: 0 };
}

async function clearFails(db, request) {
  await db.prepare('DELETE FROM login_attempts WHERE client = ?').bind(clientKey(request)).run();
}

// 로그인 시도 전 잠금 확인 — 잠겨 있으면 429 응답, 아니면 null
async function lockGuard(db, request) {
  const mins = await lockRemaining(db, request);
  if (mins === null) return null;
  return json({ error: `로그인이 잠겼습니다. ${mins}분 뒤에 다시 시도해 주세요.`, locked: true, minutes: mins }, 429);
}

// 경로별 필요한 권한: null = 공개, 'scanner' = 스캐너 코드 이상, 'admin' = 관리자만
function requiredRole(pathname, method) {
  if (pathname === '/login' || pathname === '/login.html') return null;
  // 화면을 그리는 데 필요한 정적 파일(글꼴·스타일·이미지)은 로그인 화면에서도 열려야 한다
  if (/\.(css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp)$/i.test(pathname)) return null;
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
  // 현재 상태: 초기 설정 여부 + 내 로그인 역할 + 잠금 여부
  if (pathname === '/api/auth/state' && method === 'GET') {
    const hasAdmin = Boolean(await getSetting(db, 'recovery_code'));
    const session = await getSession(db, request);
    const lockedMinutes = await lockRemaining(db, request);
    return json({ setup: hasAdmin, role: session?.role ?? null, lockedMinutes });
  }

  // 최초 1회: 관리자 QR + 비상 복구 코드 발급 (이미 설정됐으면 거부)
  if (pathname === '/api/auth/setup' && method === 'POST') {
    if (await getSetting(db, 'recovery_code')) return err('이미 초기 설정이 끝났습니다.', 409);
    const admin = await db
      .prepare('SELECT id, name, login_token FROM members WHERE is_admin = 1 ORDER BY id LIMIT 1')
      .first();
    if (!admin) return err('관리자로 지정된 인원이 없습니다.', 500);
    const recovery = newRecoveryCode();
    await setSetting(db, 'recovery_code', await hashPassword(recovery));
    const cookie = await createSession(db, 'admin', request);
    // 복구 코드는 이 응답에서 딱 한 번만 원문으로 나간다 (DB 에는 해시만 남음)
    return jsonWithCookie(
      { ok: true, role: 'admin', name: admin.name, login_token: admin.login_token, recovery_code: recovery },
      cookie,
    );
  }

  // 비상 복구 로그인 — QR 을 잃어버렸을 때만 쓰는 복구 코드
  if (pathname === '/api/auth/recovery' && method === 'POST') {
    const locked = await lockGuard(db, request);
    if (locked) return locked;
    const body = await readBody(request);
    const code = String(body?.code ?? '').trim();
    if (!code) return err('복구 코드를 입력해 주세요.');
    const hash = await getSetting(db, 'recovery_code');
    if (!hash || !(await verifyPassword(code, hash))) {
      const { fails, lockedMinutes } = await recordFail(db, request);
      if (lockedMinutes) {
        return json({ error: `${MAX_FAILS}회 틀려서 로그인이 잠겼습니다. ${lockedMinutes}분 뒤에 다시 시도해 주세요.`, locked: true, minutes: lockedMinutes }, 429);
      }
      return json({ error: `복구 코드가 올바르지 않습니다. (${fails}/${MAX_FAILS}회)`, fails, remaining: MAX_FAILS - fails }, 401);
    }
    await clearFails(db, request);
    await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
    const cookie = await createSession(db, 'admin', request);
    return jsonWithCookie({ ok: true, role: 'admin' }, cookie);
  }

  // 로그아웃
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const session = await getSession(db, request);
    if (session) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(session.token).run();
    return jsonWithCookie({ ok: true }, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  // QR 로그인 — 관리자 QR(ROLLBOOK-LOGIN:) · 스캐너 PC QR(ROLLBOOK-SCANNER:)
  if (pathname === '/api/auth/qr-login' && method === 'POST') {
    const locked = await lockGuard(db, request);
    if (locked) return locked;

    const body = await readBody(request);
    const payload = String(body?.payload ?? '').trim();
    const isAdminQr = payload.startsWith('ROLLBOOK-LOGIN:');
    const isScannerQr = payload.startsWith('ROLLBOOK-SCANNER:');

    // 출석용 QR 은 실패로 세지 않는다 — 잘못 비춘 것뿐이므로 안내만
    if (!isAdminQr && !isScannerQr) {
      if (payload.startsWith('ROLLBOOK:')) return err('출석용 QR 입니다. 로그인 QR 을 비춰 주세요.', 400);
      return err('로그인 QR 이 아닙니다.', 400);
    }

    let role = null;
    let name = '';
    if (isAdminQr) {
      const member = await db
        .prepare('SELECT name, title FROM members WHERE login_token = ? AND is_admin = 1')
        .bind(payload.slice('ROLLBOOK-LOGIN:'.length))
        .first();
      if (member) {
        role = 'admin';
        name = member.name;
      }
    } else {
      const token = await getSetting(db, 'scanner_token');
      if (token && payload.slice('ROLLBOOK-SCANNER:'.length) === token) role = 'scanner';
    }

    if (!role) {
      const { fails, lockedMinutes } = await recordFail(db, request);
      if (lockedMinutes) {
        return json({ error: `${MAX_FAILS}회 틀려서 로그인이 잠겼습니다. ${lockedMinutes}분 뒤에 다시 시도해 주세요.`, locked: true, minutes: lockedMinutes }, 429);
      }
      return json({ error: `등록되지 않았거나 해제된 로그인 QR 입니다. (${fails}/${MAX_FAILS}회)`, fails, remaining: MAX_FAILS - fails }, 401);
    }

    await clearFails(db, request);
    await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
    const cookie = await createSession(db, role, request);
    return jsonWithCookie({ ok: true, role, name }, cookie);
  }

  // 관리자 지정 목록/추가/해제 (관리자만)
  if (pathname === '/api/auth/admins' || (seg[2] === 'admins' && seg.length === 4)) {
    const session = await getSession(db, request);
    if (session?.role !== 'admin') return json({ error: '로그인이 필요합니다.', auth: true }, 401);

    if (pathname === '/api/auth/admins' && method === 'GET') {
      const { results } = await db
        .prepare('SELECT id, name, title, dept, login_token FROM members WHERE is_admin = 1 ORDER BY name, id')
        .all();
      return json({ admins: results });
    }

    if (pathname === '/api/auth/admins' && method === 'POST') {
      const body = await readBody(request);
      const memberId = Number(body?.member_id);
      if (!Number.isInteger(memberId)) return err('잘못된 회원 ID 입니다.');
      const member = await db.prepare('SELECT id, login_token FROM members WHERE id = ?').bind(memberId).first();
      if (!member) return err('명단에서 회원을 찾을 수 없습니다.', 404);
      await db
        .prepare('UPDATE members SET is_admin = 1, login_token = COALESCE(login_token, ?) WHERE id = ?')
        .bind(newLoginToken(), memberId)
        .run();
      const admin = await db
        .prepare('SELECT id, name, title, dept, login_token FROM members WHERE id = ?')
        .bind(memberId)
        .first();
      return json({ admin });
    }

    // 해제 — 로그인 토큰도 폐기해서 이미 만든 QR 을 무효화
    if (seg[2] === 'admins' && seg.length === 4 && method === 'DELETE') {
      const memberId = Number(seg[3]);
      if (!Number.isInteger(memberId)) return err('잘못된 회원 ID 입니다.');
      const count = await db.prepare('SELECT COUNT(*) AS n FROM members WHERE is_admin = 1').first();
      if ((count?.n ?? 0) <= 1) return err('마지막 관리자는 해제할 수 없습니다.');
      await db.prepare('UPDATE members SET is_admin = 0, login_token = NULL WHERE id = ?').bind(memberId).run();
      return json({ ok: true });
    }
  }

  // 스캐너 PC 로그인 QR 토큰 보기 / 재발급 (관리자만)
  if (pathname === '/api/auth/scanner-qr') {
    const session = await getSession(db, request);
    if (session?.role !== 'admin') return json({ error: '로그인이 필요합니다.', auth: true }, 401);
    if (method === 'GET') {
      return json({ token: (await getSetting(db, 'scanner_token')) ?? '' });
    }
    // 재발급 — 기존 QR 은 무효가 되고 로그인돼 있던 스캐너 PC 도 모두 풀린다
    if (method === 'POST') {
      const token = newScannerToken();
      await setSetting(db, 'scanner_token', token);
      await db.prepare("DELETE FROM sessions WHERE role = 'scanner'").run();
      return json({ ok: true, token });
    }
  }

  // 비상 복구 코드 재발급 (관리자만) — 새 코드는 이 응답에서만 원문으로 나간다
  if (pathname === '/api/auth/recovery-code' && method === 'POST') {
    const session = await getSession(db, request);
    if (session?.role !== 'admin') return json({ error: '로그인이 필요합니다.', auth: true }, 401);
    const code = newRecoveryCode();
    await setSetting(db, 'recovery_code', await hashPassword(code));
    return json({ ok: true, code });
  }

  // 로그인 잠금 풀기 (관리자만)
  if (pathname === '/api/auth/unlock' && method === 'POST') {
    const session = await getSession(db, request);
    if (session?.role !== 'admin') return json({ error: '로그인이 필요합니다.', auth: true }, 401);
    await db.prepare('DELETE FROM login_attempts').run();
    return json({ ok: true });
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
