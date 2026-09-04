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
    db.prepare(`CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      kind TEXT NOT NULL DEFAULT 'auto',
      members INTEGER NOT NULL DEFAULT 0,
      sheets INTEGER NOT NULL DEFAULT 0,
      records INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT,
      json TEXT NOT NULL
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
    await db.prepare('ALTER TABLE backups ADD COLUMN fingerprint TEXT').run();
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

  // 예전 접속코드 방식은 QR 로 대체 — 남아 있던 값 정리
  await db.prepare("DELETE FROM settings WHERE key = 'scanner_code'").run();

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

// 이름 비교용 정규화 — 띄어쓰기만 다른 경우를 같은 사람으로 본다
// (동명이인은 회사 관례대로 이름 뒤 숫자로 구분하므로 숫자는 그대로 둔다)
const nameKey = (s) => String(s ?? '').replace(/\s+/g, '');

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
  // 워크샵 참석자 화면 — 명찰 QR 로 로그인 없이 여는 것이 목적이라 이 세 주소만 공개.
  // 관리 화면(/workshop/admin)은 아래 기본값대로 관리자만 연다.
  if (pathname === '/workshop' || pathname === '/workshop/' || pathname === '/workshop/index.html') return null;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/scan' || pathname === '/scanner.js') return 'scanner';
  if (pathname === '/api/status' || pathname === '/api/recent' || pathname === '/api/checkin') return 'scanner';
  return 'admin';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      await ensureSchema(env.DB);

      // 접속 권한 검사 — 페이지는 로그인 화면으로, API 는 401 로
      const need = requiredRole(pathname, request.method);
      let session = null;
      if (need) {
        session = await getSession(env.DB, request);
        const allowed = session && (session.role === 'admin' || (need === 'scanner' && session.role === 'scanner'));
        if (!allowed) {
          if (pathname.startsWith('/api/')) return json({ error: '로그인이 필요합니다.', auth: true }, 401);
          return Response.redirect(new URL(`/login?next=${encodeURIComponent(pathname)}`, request.url).toString(), 302);
        }
      }

      // 관리자가 주소만 치고 들어오면 스캔 화면이 아니라 메뉴가 뜨게 한다.
      // 스캐너 PC(스캐너 권한)는 예전처럼 '/' 가 곧 스캔 화면이다.
      if ((pathname === '/' || pathname === '/index.html') && session?.role === 'admin') {
        return Response.redirect(new URL('/start', request.url).toString(), 302);
      }
      // 관리자가 메뉴에서 스캔 화면을 열 때 쓰는 주소 (여기서는 되돌리지 않는다)
      if (pathname === '/scan') {
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), { headers: request.headers }));
      }

      // 워크샵 화면은 한 파일을 두 가지로 내보낸다 — 참석자용(관리 도구 제거) / 관리자용
      const wsView = workshopView(pathname);
      if (wsView) return serveWorkshop(request, env, wsView);

      if (!pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      const res = await route(request, env, pathname);
      // 자료가 바뀌었으면 응답을 보낸 뒤 백업을 한 벌 떠 둔다 (내용이 같으면 건너뜀)
      if (res && res.ok && changesData(pathname, request.method)) {
        const after = saveSnapshot(env.DB, 'auto', { onlyIfChanged: true }).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(after);
      }
      return res ?? err('찾을 수 없는 API 경로입니다.', 404);
    } catch (e) {
      // 오류가 나도 공개 자산(로그인 화면·CSS 등)은 열리고, 보호 자산은 열리지 않는다
      if (!pathname.startsWith('/api/') && requiredRole(pathname, request.method) === null) {
        return env.ASSETS.fetch(request);
      }
      return err(`서버 오류: ${e.message}`, 500);
    }
  },

  // 매일 자동 백업 (wrangler.jsonc 의 crons 설정)
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await ensureSchema(env.DB);
        const d = await saveSnapshot(env.DB, 'auto', { onlyIfChanged: true });
        console.log(d
          ? `자동 백업 완료 — 명단 ${d.members.length}명, 출석기록 ${d.attendance.length}건`
          : '변동 없음 — 백업도 정리도 하지 않음');
      } catch (e) {
        console.log('자동 백업 실패:', e.message);
      }
    })());
  },
};

// ── 백업 ────────────────────────────────────────────
// 명단·출석부·출석기록을 JSON 한 덩어리로 뜬다.
// 로그인 토큰·비밀번호 해시·복구 코드·세션은 일부러 넣지 않는다 —
// 백업 파일이 곧 관리자 열쇠가 되면 안 되기 때문. 복원할 때는 이미 있는
// 관리자 QR 을 코드(code) 기준으로 다시 붙여 준다.
const BACKUP_KEEP_DAYS = 7;        // 보관 기간 1주일
const BACKUP_COALESCE_MS = 60000;  // 1분 안에 여러 번 바뀌면 한 줄로 합친다 (출석 스캔이 몰릴 때)

// 백업 내용의 지문 — 같은 내용을 또 저장하지 않기 위한 것
async function backupFingerprint(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildBackup(db) {
  const [members, sheets, attendance, logo] = await Promise.all([
    db.prepare('SELECT id, name, title, dept, code, is_admin, created_at FROM members ORDER BY id').all(),
    db.prepare('SELECT id, title, sheet_date, is_active, created_at FROM sheets ORDER BY id').all(),
    db.prepare('SELECT id, sheet_id, member_id, checked_at FROM attendance ORDER BY id').all(),
    db.prepare("SELECT value FROM settings WHERE key = 'brand_logo'").first(),
  ]);
  return {
    format: 'rollbook-backup',
    version: 1,
    created_at: new Date().toISOString(),
    members: members.results ?? [],
    sheets: sheets.results ?? [],
    attendance: attendance.results ?? [],
    brand_logo: logo?.value ?? null,
  };
}

// 1주일이 지난 백업을 지운다.
// 이 정리는 '새 백업을 방금 만들었을 때만' 부른다. 그래서 한동안 아무 변동이
// 없으면 지우지도 않고, 방금 만든 백업은 0일짜리라 늘 살아남는다 —
// 백업이 하나도 없어지는 상황이 구조적으로 생기지 않는다.
async function pruneBackups(db) {
  const cutoff = new Date(Date.now() - BACKUP_KEEP_DAYS * 86400000).toISOString();
  await db.prepare('DELETE FROM backups WHERE created_at < ?').bind(cutoff).run();
}

// 백업 한 벌 저장.
//  - onlyIfChanged : 내용이 직전 백업과 같으면 아무 것도 하지 않는다
//  - 1분 안에 또 바뀌면 새 줄을 만들지 않고 마지막 자동 백업을 최신 내용으로 갱신한다
//    (출석 스캔이 몰릴 때 줄이 수백 개로 늘어나지 않도록)
async function saveSnapshot(db, kind = 'auto', { onlyIfChanged = false } = {}) {
  const data = await buildBackup(db);
  const text = JSON.stringify(data);
  // 지문은 '내용' 만으로 낸다 — 뜬 시각(created_at)까지 넣으면 매번 달라져
  // '바뀐 게 없으면 건너뛰기' 가 아예 동작하지 않는다.
  const { created_at: _at, ...content } = data;
  const fp = await backupFingerprint(JSON.stringify(content));

  // '마지막 백업' 도 시각 기준으로 본다 (목록·정리와 같은 기준)
  const last = await db.prepare(
    'SELECT id, kind, created_at, fingerprint FROM backups ORDER BY created_at DESC, id DESC LIMIT 1',
  ).first();

  if (onlyIfChanged && last && last.fingerprint === fp) return null; // 바뀐 게 없다

  const fresh = last && Date.now() - Date.parse(last.created_at) < BACKUP_COALESCE_MS;
  if (kind === 'auto' && last && last.kind === 'auto' && fresh) {
    await db.prepare(
      `UPDATE backups SET created_at = ?, members = ?, sheets = ?, records = ?, bytes = ?, fingerprint = ?, json = ?
        WHERE id = ?`,
    ).bind(
      new Date().toISOString(), data.members.length, data.sheets.length, data.attendance.length,
      text.length, fp, text, last.id,
    ).run();
  } else {
    await db.prepare(
      'INSERT INTO backups (kind, members, sheets, records, bytes, fingerprint, json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(kind, data.members.length, data.sheets.length, data.attendance.length, text.length, fp, text).run();
  }
  await pruneBackups(db);
  return data;
}

// 자료를 바꾸는 요청인지 — 그렇다면 응답을 보낸 뒤 백업을 한 벌 떠 둔다.
// 로그인 관련(/api/auth/)·백업 자체·워크샵(다른 DB)은 제외한다.
function changesData(pathname, method) {
  if (method === 'GET' || method === 'HEAD') return false;
  if (!pathname.startsWith('/api/')) return false;
  if (pathname.startsWith('/api/auth/')) return false;
  if (pathname.startsWith('/api/backup/')) return false;
  if (pathname.startsWith('/api/workshop/')) return false;
  return true;
}

// 백업 JSON 으로 되돌리기. 명단·출석부·출석기록을 통째로 갈아 끼우되,
// 지금 쓰고 있는 관리자 QR·권한은 코드가 같은 사람에게 그대로 남긴다.
async function restoreBackup(db, data) {
  if (!data || data.format !== 'rollbook-backup' || !Array.isArray(data.members)) {
    throw new Error('백업 파일 형식이 아닙니다.');
  }
  const keep = new Map();
  const cur = await db.prepare('SELECT code, is_admin, login_token FROM members').all();
  for (const m of cur.results ?? []) keep.set(m.code, m);

  const stmts = [
    db.prepare('DELETE FROM attendance'),
    db.prepare('DELETE FROM sheets'),
    db.prepare('DELETE FROM members'),
  ];
  for (const m of data.members) {
    const had = keep.get(m.code);
    stmts.push(db.prepare(
      'INSERT INTO members (id, name, title, dept, code, is_admin, login_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      m.id, m.name ?? '', m.title ?? '', m.dept ?? '', m.code,
      had ? had.is_admin : (m.is_admin ?? 0),
      had ? had.login_token : null,
      m.created_at ?? new Date().toISOString(),
    ));
  }
  for (const sh of data.sheets ?? []) {
    stmts.push(db.prepare(
      'INSERT INTO sheets (id, title, sheet_date, is_active, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(sh.id, sh.title ?? '', sh.sheet_date ?? '', sh.is_active ?? 0, sh.created_at ?? new Date().toISOString()));
  }
  for (const a of data.attendance ?? []) {
    stmts.push(db.prepare(
      'INSERT INTO attendance (id, sheet_id, member_id, checked_at) VALUES (?, ?, ?, ?)',
    ).bind(a.id, a.sheet_id, a.member_id, a.checked_at ?? new Date().toISOString()));
  }
  if (data.brand_logo) {
    stmts.push(db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('brand_logo', ?)").bind(data.brand_logo));
  }
  await db.batch(stmts);
  return {
    members: data.members.length,
    sheets: (data.sheets ?? []).length,
    records: (data.attendance ?? []).length,
  };
}

// ── 워크샵 데이터 (전용 데이터베이스) ────────────────
// 받은 워크샵 앱은 명단·조배정·프로그램이 파일 안에 상수로 박혀 있다.
// 그 상수 자리에 데이터베이스에 저장해 둔 값을 끼워 넣어 내보낸다 —
// 파일 자체는 손대지 않으므로 앱을 새로 받아도 그대로 갈아 끼우면 된다.
const WS_KEYS = ['META', 'PEOPLE', 'PROGRAM', 'DINNER'];
let wsSchemaReady = false;
let wsCache = { id: null, html: null };

async function ensureWsSchema(env) {
  if (wsSchemaReady || !env.WSDB) return;
  await env.WSDB.prepare(`CREATE TABLE IF NOT EXISTS ws_dataset (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    note TEXT NOT NULL DEFAULT '',
    people_count INTEGER NOT NULL DEFAULT 0,
    group_count INTEGER NOT NULL DEFAULT 0,
    meta_json TEXT NOT NULL,
    people_json TEXT NOT NULL,
    program_json TEXT NOT NULL,
    dinner_json TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 0
  )`).run();
  wsSchemaReady = true;
}

// 파일 안에서 상수 네 개의 값 위치를 찾는다.
// RAW_TEMPLATE (파일을 다시 만들 때 쓰는 틀) 안에도 같은 이름이 있으므로 그 앞까지만 본다.
function wsFindSpans(html) {
  const limit = html.indexOf('const RAW_TEMPLATE');
  const end = limit === -1 ? html.length : limit;
  const spans = {};
  for (const k of WS_KEYS) {
    const decl = `const ${k} = `;
    const i = html.indexOf(decl);
    if (i === -1 || i >= end) return null;
    const vs = i + decl.length;
    const ve = html.indexOf(';\n', vs);
    if (ve === -1 || ve >= end) return null;
    spans[k] = [vs, ve];
  }
  return spans;
}

function wsExtract(html) {
  const read = wsRead(html);
  return read.error ? null : read.data;
}

// 실패했을 때 '무엇이 잘못됐는지' 까지 돌려준다 — 관리 화면에 그대로 띄운다
function wsRead(html) {
  const text = String(html ?? '');
  if (!text.trim()) return { error: '보낸 파일이 비어 있습니다.', detail: '내용이 0바이트입니다.' };
  if (!/<html|<!doctype/i.test(text.slice(0, 400))) {
    return {
      error: 'HTML 파일이 아닙니다.',
      detail: `파일 앞부분이 “${text.slice(0, 60).replace(/\s+/g, ' ')}” 입니다. 워크샵 관리 화면이 만든 index.html 을 넣어 주세요.`,
    };
  }
  const spans = wsFindSpans(text);
  if (!spans) {
    const missing = WS_KEYS.filter((k) => text.indexOf(`const ${k} = `) === -1);
    return {
      error: '워크샵 앱이 만든 index.html 이 아닙니다.',
      detail: missing.length
        ? `파일 안에서 ${missing.join(', ')} 자료를 찾지 못했습니다.`
        : '자료 선언은 있으나 형태가 예상과 다릅니다 (앱 버전이 다를 수 있습니다).',
    };
  }
  const out = {};
  for (const k of WS_KEYS) {
    try {
      out[k] = JSON.parse(text.slice(spans[k][0], spans[k][1]));
    } catch (e) {
      return { error: `${k} 자료를 읽지 못했습니다.`, detail: `${e.message} — 파일이 도중에 잘렸을 수 있습니다.` };
    }
  }
  if (!Array.isArray(out.PEOPLE)) return { error: '명단(PEOPLE)이 목록 형태가 아닙니다.', detail: `받은 형태: ${typeof out.PEOPLE}` };
  if (!out.PEOPLE.length) return { error: '명단이 비어 있습니다.', detail: '엑셀에서 참석자를 한 명도 읽지 못한 파일입니다.' };
  if (!out.PEOPLE[0]?.name) return { error: '명단에 이름 칸이 없습니다.', detail: `첫 줄: ${JSON.stringify(out.PEOPLE[0]).slice(0, 120)}` };
  return { data: out };
}

function wsReplace(html, data) {
  const spans = wsFindSpans(html);
  if (!spans) return html;
  // 뒤쪽부터 바꿔야 앞쪽 위치가 밀리지 않는다
  const order = WS_KEYS.slice().sort((a, b) => spans[b][0] - spans[a][0]);
  let out = html;
  for (const k of order) {
    const [vs, ve] = spans[k];
    out = out.slice(0, vs) + JSON.stringify(data[k]) + out.slice(ve);
  }
  return out;
}

async function wsActiveData(env) {
  if (!env.WSDB) return null;
  try {
    await ensureWsSchema(env);
    const row = await env.WSDB.prepare(
      'SELECT id, meta_json, people_json, program_json, dinner_json FROM ws_dataset WHERE is_active = 1 ORDER BY id DESC LIMIT 1',
    ).first();
    if (!row) return null;
    return {
      id: row.id,
      META: JSON.parse(row.meta_json),
      PEOPLE: JSON.parse(row.people_json),
      PROGRAM: JSON.parse(row.program_json),
      DINNER: JSON.parse(row.dinner_json),
    };
  } catch {
    return null; // 워크샵 DB 가 아직 없으면 파일에 박힌 원래 데이터를 쓴다
  }
}

// ── 워크샵 화면 ──────────────────────────────────────
// 다른 사람이 만든 단일 파일 앱(public/workshop/index.html)을 손대지 않고,
// 내보낼 때만 두 가지로 가공한다.
//   'public' : 참석자용 — 관리자 버튼·관리 패널·엑셀 라이브러리를 뺀다
//   'admin'  : 관리자용 — 위에 메뉴 줄을 얹고 관리 패널을 바로 연다
function workshopView(pathname) {
  if (pathname === '/workshop' || pathname === '/workshop/' || pathname === '/workshop/index.html') return 'public';
  if (pathname === '/workshop/admin' || pathname === '/workshop/admin/') return 'admin';
  return null;
}

const WS_ADMIN_BAR_CSS = `
  /* 관리 화면은 참석자가 보는 그 화면을 그대로 쓴다. '직접 편집' 을 누르면 같은 모양의
     편집본으로 바뀌고(workshop-admin.js 가 .rb-editing 으로 갈아 끼운다), 참석자용 주소는
     '참석자 화면 보기' 단추로만 연다. */
  .wrap > .admin-toggle-row { display: none !important; }   /* 관리 패널은 이미 열어 두므로 '관리자' 글자는 감춘다 */
  .wrap > .admin-panel { margin-top: 18px; }
  /* 관리자 줄 — 원본 앱의 색·글꼴 변수를 그대로 써서 한 앱처럼 보이게 한다 */
  .rb-adminbar { position: sticky; top: 0; z-index: 1000; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 10px 16px; background: var(--surface); color: var(--text); border-bottom: 1px solid var(--border); box-shadow: var(--shadow);
    font-family: 'Noto Sans KR', -apple-system, BlinkMacSystemFont, 'Malgun Gothic', sans-serif; font-size: 13px; line-height: 1; }
  .rb-adminbar a, .rb-adminbar button { display: inline-flex; align-items: center; color: var(--text); text-decoration: none; padding: 8px 12px;
    border-radius: 10px; border: 1px solid var(--border); background: var(--surface-alt); font: inherit; font-weight: 700; cursor: pointer; }
  .rb-adminbar a:hover, .rb-adminbar button:hover { background: var(--accent-soft); border-color: var(--accent-soft-border); color: var(--accent-strong); }
  .rb-adminbar a.view { background: var(--accent); border-color: var(--accent); color: #fff; }
  .rb-adminbar a.view:hover { background: var(--accent-strong); border-color: var(--accent-strong); color: #fff; }
  .rb-adminbar .t { flex: 1; font-weight: 800; font-size: 15px; letter-spacing: -.01em; }
  .rb-adminbar .s { display: inline-block; font-weight: 500; font-size: 12.5px; color: var(--text-muted); margin-left: 8px; }
  @media (max-width: 560px) {
    .rb-adminbar { gap: 6px; padding: 8px 12px; }
    .rb-adminbar .t { flex: 1 0 100%; order: -1; margin-bottom: 2px; }
    .rb-adminbar .s { display: none; }
    .rb-adminbar a, .rb-adminbar button { flex: 1 1 auto; justify-content: center; padding: 8px 8px; font-size: 12px; white-space: nowrap; }
  }
  .rb-note { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px;
    background: var(--highlight-bg); border-bottom: 1px solid var(--highlight-border); color: var(--highlight-text);
    font-family: 'Noto Sans KR', -apple-system, BlinkMacSystemFont, 'Malgun Gothic', sans-serif; font-size: 12.5px; line-height: 1.5; }
  .rb-note b { font-size: 13px; }
  .rb-note span { flex: 1; min-width: 200px; }
  .rb-note button { padding: 8px 14px; border: 1px solid var(--highlight-border); border-radius: 9px;
    background: var(--surface); color: var(--text); font: 700 12.5px inherit; cursor: pointer; }
  .rb-note button:hover { background: var(--accent-soft); border-color: var(--accent-soft-border); color: var(--accent-strong); }
  .rb-pub { margin: 0; padding: 14px 16px; background: var(--surface-alt); border-bottom: 1px solid var(--border);
    font-family: 'Noto Sans KR', -apple-system, BlinkMacSystemFont, 'Malgun Gothic', sans-serif; font-size: 13px; line-height: 1.5; color: var(--text); }
  .rb-pub button { padding: 7px 12px; border: 1px solid var(--border); border-radius: 9px;
    background: var(--surface); color: var(--text); font: inherit; font-weight: 700; cursor: pointer; }
  .rb-pub button:hover { background: var(--accent-soft); border-color: var(--accent-soft-border); color: var(--accent-strong); }
  .rb-pub .msg { display: block; margin-top: 8px; font-size: 12.5px; }
  .rb-pub .msg.ok { color: #15803D; } .rb-pub .msg.err { color: #C81330; }
  .rb-pub table { margin-top: 4px; border-collapse: collapse; font-size: 12.5px; }
  .rb-pub td { padding: 5px 12px 5px 0; }`;

// 원본 앱은 claude.ai 아티팩트 안에서 돌 때만 '게시하기' 로 스스로를 갱신하고,
// 그 밖에서는 파일을 내려받게 되어 있다. 파일을 고치지 않고 그 갈림길만 빌려 쓴다 —
// claude.use('artifact').publish(html) 를 우리 서버 반영으로 연결하면
// 관리자는 '게시하기' 한 번으로 참석자 화면까지 바꾼다.
const WS_PUBLISH_SHIM = `(function(){
  if (window.claude) return;
  window.claude = { use: async function(name){
    if (name !== 'artifact') return null;
    return { publish: async function(html){
      var r;
      try {
        r = await fetch('/api/workshop/publish', {
          method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: html });
      } catch (e) {
        var netInfo = { step: '전송', error: '서버에 연결하지 못했습니다.', detail: e.message, status: 0 };
        if (window.rbFail) window.rbFail(netInfo);
        throw new Error(netInfo.error);
      }
      var d = await r.json().catch(function(){ return {}; });
      if (!r.ok) {
        var info = { step: d.step || '서버 반영',
          error: d.error || ('서버가 ' + r.status + ' 로 응답했습니다.'),
          detail: d.detail || '', status: r.status };
        if (window.rbFail) window.rbFail(info);
        throw new Error(info.error + (info.detail ? ' — ' + info.detail : ''));
      }
      // 적용 내역은 화면에 띄우고, 새로고침은 관리자가 그 창을 닫을 때 한다
      if (window.rbDone) window.rbDone(d);
      else setTimeout(function(){ location.reload(); }, 1200);
      return d;
    } };
  } };
})();`;


// 앱 파일 안의 자료와 지금 쓰는 자료가 같은 내용인지 (알림용이라 대충 견주지 않고 통째로 견준다)
function wsSameData(a, b) {
  return WS_KEYS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

// 워크샵 반영 실패 — 어느 단계에서 왜 막혔는지 화면에 그대로 띄울 수 있게 내려보낸다
function wsFail(info, step) {
  return json({ error: info.error, detail: info.detail ?? '', step }, info.status ?? 400);
}

// 편집 화면이 보낸 자료가 쓸 만한지 확인한다 (내용은 관리자가 책임진다).
// 어긋나면 어느 칸이 문제인지까지 돌려준다.
function wsCheckData(body) {
  const bad = (error, detail) => ({ error, detail });
  if (!body || typeof body !== 'object') return bad('보낸 자료를 읽지 못했습니다.', 'JSON 본문이 아닙니다.');
  const { META, PEOPLE, PROGRAM, DINNER } = body;
  if (!Array.isArray(PEOPLE)) return bad('명단이 목록 형태가 아닙니다.', `받은 형태: ${typeof PEOPLE}`);
  if (!PEOPLE.length) return bad('명단이 비어 있습니다.', '한 명 이상은 있어야 저장할 수 있습니다.');
  const noName = PEOPLE.findIndex((p) => !p || typeof p.name !== 'string' || !p.name.trim());
  if (noName !== -1) return bad('이름이 비어 있는 줄이 있습니다.', `${noName + 1}번째 줄 — 이름을 채우거나 그 줄을 지워 주세요.`);
  if (!Array.isArray(DINNER)) return bad('석식 명단이 목록 형태가 아닙니다.', `받은 형태: ${typeof DINNER}`);
  if (!PROGRAM || typeof PROGRAM !== 'object') return bad('프로그램 자료가 없습니다.', `받은 형태: ${typeof PROGRAM}`);
  if (!Array.isArray(PROGRAM.days)) return bad('프로그램의 일자 목록이 없습니다.', '일자를 하나 이상 두어야 합니다.');
  return { data: { META: META && typeof META === 'object' ? META : {}, PEOPLE, PROGRAM, DINNER } };
}

// 한 벌이 어떤 내용인지 한눈에 (관리 화면의 '적용 내역' 에 그대로 쓴다)
function wsSummary(data) {
  const count = (list) => new Set(list.map((x) => x.groupLabel || x.group).filter((x) => x != null)).size;
  const days = (data.PROGRAM?.days ?? []).map((d) => ({ label: d.label ?? '', rows: (d.rows ?? []).length }));
  return {
    people: data.PEOPLE.length,
    groups: count(data.PEOPLE),
    dinner: data.DINNER.length,
    dinnerGroups: count(data.DINNER),
    title: data.PROGRAM?.title ?? '',
    dateRange: data.PROGRAM?.dateRange ?? '',
    days,
    rows: days.reduce((n, d) => n + d.rows, 0),
    lineup: (data.PROGRAM?.lineup ?? []).reduce((n, g) => n + (g.items?.length ?? 0), 0),
  };
}

// 지금 쓰고 있는 한 벌과 견줘 무엇이 달라지는지 (동명이인 때문에 본부까지 묶어 센다)
const WS_DIFF_CAP = 40;
function wsDiff(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null;
  const key = (p) => `${p.name}|${p.hub ?? ''}`;
  const where = (p) => p.groupLabel || `${p.group}조`;
  const before = new Map(prev.map((p) => [key(p), p]));
  const after = new Map(next.map((p) => [key(p), p]));
  const added = [];
  const moved = [];
  const removed = [];
  next.forEach((p) => {
    const o = before.get(key(p));
    if (!o) added.push(p.name);
    else if (where(o) !== where(p)) moved.push({ name: p.name, from: where(o), to: where(p) });
  });
  prev.forEach((p) => { if (!after.has(key(p))) removed.push(p.name); });
  return {
    addedCount: added.length,
    removedCount: removed.length,
    movedCount: moved.length,
    kept: next.length - added.length,
    added: added.slice(0, WS_DIFF_CAP),
    removed: removed.slice(0, WS_DIFF_CAP),
    moved: moved.slice(0, WS_DIFF_CAP),
  };
}

// 한 벌을 새 버전으로 쌓고 그것만 사용 중으로 둔다 (엑셀 게시·직접 편집 공용).
// 실패하면 던지지 않고 { error, detail } 로 돌려준다 — 화면에 그대로 띄우기 위해서다.
async function wsSaveDataset(env, data) {
  let prev = null;
  try {
    await ensureWsSchema(env);
    prev = await wsActiveData(env);
  } catch (e) {
    return { error: '워크샵 데이터베이스를 준비하지 못했습니다.', detail: e.message, status: 503 };
  }
  const sum = wsSummary(data);
  let id;
  try {
    const res = await env.WSDB.prepare(
      `INSERT INTO ws_dataset (note, people_count, group_count, meta_json, people_json, program_json, dinner_json, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).bind(
      sum.title, sum.people, sum.groups,
      JSON.stringify(data.META), JSON.stringify(data.PEOPLE),
      JSON.stringify(data.PROGRAM), JSON.stringify(data.DINNER),
    ).run();
    id = res.meta?.last_row_id;
    await env.WSDB.prepare('UPDATE ws_dataset SET is_active = 0 WHERE id <> ?').bind(id).run();
  } catch (e) {
    return { error: '데이터베이스에 저장하지 못했습니다.', detail: e.message, status: 500 };
  }
  wsCache = { id: null, html: null };
  return {
    id,
    prevId: prev?.id ?? null,
    at: new Date().toISOString(),
    ...sum,
    diff: wsDiff(prev?.PEOPLE, data.PEOPLE),
    dinnerDiff: wsDiff(prev?.DINNER, data.DINNER),
  };
}

async function serveWorkshop(request, env, view) {
  // 주소를 한 가지로 맞춘다 (참석자 QR 에는 /workshop/ 만 쓴다)
  if (view === 'public' && new URL(request.url).pathname !== '/workshop/') {
    return Response.redirect(new URL('/workshop/', request.url).toString(), 301);
  }
  const asset = await env.ASSETS.fetch(new Request(new URL('/workshop/', request.url), { headers: request.headers }));
  if (!asset.ok) return asset;

  // 데이터베이스에 올려 둔 명단이 있으면 파일 안의 상수를 그것으로 바꿔 내보낸다
  const data = await wsActiveData(env);
  const cacheKey = data ? data.id : 0;
  let html = wsCache.id === cacheKey ? wsCache.html : null;
  let raw = null;
  if (!html) {
    raw = await asset.text();
    html = data ? wsReplace(raw, data) : raw;
    wsCache = { id: cacheKey, html };
  }

  // 관리 화면에서만: 앱 파일 안의 자료와 지금 쓰는 자료가 다르면 알려 준다.
  // (개발자가 새 index.html 을 줬는데 DB 버전이 사용 중이면 화면이 안 바뀌기 때문)
  let fileDiff = null;
  if (view === 'admin' && data) {
    try {
      if (raw === null) {
        const again = await env.ASSETS.fetch(new Request(new URL('/workshop/', request.url), { headers: request.headers }));
        raw = again.ok ? await again.text() : null;
      }
      const fileData = raw ? wsExtract(raw) : null;
      if (fileData && wsSameData(fileData, data) === false) {
        fileDiff = { people: fileData.PEOPLE.length, build: fileData.META?.buildDate ?? '' };
      }
    } catch { /* 알림은 곁다리니 실패해도 화면은 그대로 낸다 */ }
  }
  const page = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  const rw = new HTMLRewriter();
  if (view === 'public') {
    rw.on('head', { element(el) { el.append('<style>#adminLinkBtn,#adminPanel{display:none!important}</style>', { html: true }); } })
      .on('#adminLinkBtn', { element(el) { el.setAttribute('hidden', ''); el.setAttribute('aria-hidden', 'true'); } })
      .on('#adminPanel', { element(el) { el.setAttribute('hidden', ''); el.setAttribute('aria-hidden', 'true'); } })
      // 엑셀 업로드용 라이브러리는 참석자에게 필요 없다 (관리 패널이 없으니 부르지도 않는다)
      .on('script[src*="xlsx"]', { element(el) { el.remove(); } });
  } else {
    rw.on('head', {
      element(el) {
        // 다리는 원본 스크립트(문서 끝)보다 먼저 놓여야 '게시하기' 라벨이 그대로 남는다
        el.append(`<script>${WS_PUBLISH_SHIM}</script>`, { html: true });
        el.append(`<style>${WS_ADMIN_BAR_CSS}</style>`, { html: true });
      },
    })
      .on('body', {
        element(el) {
          el.prepend(
            '<div class="rb-adminbar"><a href="/start">← 메뉴</a>' +
            '<span class="t">워크샵 관리<span class="s">엑셀로 한꺼번에 갱신하거나, 직접 편집으로 한 줄씩 고칩니다</span></span>' +
            '<button type="button" id="rbEditOpen">직접 편집</button>' +
            '<button type="button" id="rbPubList">지난 버전</button>' +
            '<a class="view" href="/workshop/" target="_blank" rel="noopener">참석자 화면 보기 ↗</a></div>' +
            '<div class="rb-pub" id="rbPubBox" hidden><span class="msg" id="rbPubMsg"></span>' +
            '<div id="rbPubVers"></div></div>' +
            (fileDiff
              ? '<div class="rb-note"><b>앱 파일에 다른 자료가 들어 있습니다</b>'
                + '<span>지금 화면은 올려 둔 버전을 쓰고 있습니다. 개발자가 준 새 파일의 자료'
                + ' (' + fileDiff.people + '명' + (fileDiff.build ? ' · ' + fileDiff.build : '') + ')'
                + ' 를 쓰려면 아래를 누르세요. 올려 둔 버전은 지난 버전 목록에 그대로 남습니다.</span>'
                + '<button type="button" id="rbUseFile">앱 파일의 자료로 바꾸기</button></div>'
              : ''),
            { html: true },
          );
          // 관리자용 스크립트(관리 패널 펼치기·지난 버전·직접 편집)는 파일로 둔다.
          // 원본 스크립트 뒤에 실려야 PEOPLE·PROGRAM·DINNER 를 읽을 수 있다.
          el.append('<script src="/workshop-admin.js"></script>', { html: true });
        },
      });
  }
  const out = rw.transform(page);
  const h = new Headers(out.headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');   // 두 가지 화면이 같은 파일에서 나오므로 캐시하지 않는다
  return new Response(out.body, { status: out.status, headers: h });
}

async function route(request, env, pathname) {
  const db = env.DB;

  // ── 백업 (관리자 전용) ──────────────────────────────
  if (pathname === '/api/backup/list' && request.method === 'GET') {
    const r = await db.prepare(
      'SELECT id, created_at, kind, members, sheets, records, bytes, fingerprint FROM backups ORDER BY created_at DESC, id DESC LIMIT 60',
    ).all();
    return json({ backups: r.results ?? [], days: BACKUP_KEEP_DAYS });
  }

  if (pathname === '/api/backup/snapshot' && request.method === 'POST') {
    const d = await saveSnapshot(db, 'manual');
    return json({ ok: true, members: d.members.length, sheets: d.sheets.length, records: d.attendance.length });
  }

  // 지금 상태를 파일로 내려받기 (id 를 주면 그때 떠 둔 스냅샷)
  if (pathname === '/api/backup/download' && request.method === 'GET') {
    const id = Number(new URL(request.url).searchParams.get('id') || 0);
    let text;
    let stamp;
    if (id) {
      const row = await db.prepare('SELECT created_at, json FROM backups WHERE id = ?').bind(id).first();
      if (!row) return err('그 백업을 찾을 수 없습니다.', 404);
      text = row.json;
      stamp = String(row.created_at).slice(0, 19).replace(/[:T]/g, '');
    } else {
      text = JSON.stringify(await buildBackup(db), null, 2);
      stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    }
    return new Response(text, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="rollbook-backup-${stamp}.json"`,
        'cache-control': 'no-store',
      },
    });
  }

  if (pathname === '/api/backup/restore' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (!body || body.confirm !== true) return err('복원하려면 확인이 필요합니다.', 400);
    // 되돌리기 직전 상태를 먼저 떠 둔다 (잘못 복원했을 때 되살릴 수 있도록)
    await saveSnapshot(db, 'manual').catch(() => {});
    const n = await restoreBackup(db, body.data);
    return json({ ok: true, ...n });
  }

  // ── 워크샵 데이터 (전용 데이터베이스, 관리자 전용) ──
  if (pathname === '/api/workshop/publish' && request.method === 'POST') {
    if (!env.WSDB) return wsFail({ error: '워크샵 데이터베이스가 연결되어 있지 않습니다.', detail: 'WSDB 바인딩이 없습니다 — 배포 설정을 확인해 주세요.', status: 503 }, '준비');
    const read = wsRead(await request.text());
    if (read.error) return wsFail({ ...read, status: 400 }, '파일 읽기');
    const saved = await wsSaveDataset(env, read.data);
    if (saved.error) return wsFail(saved, '저장');
    return json({ ok: true, source: 'excel', ...saved });
  }

  // 관리 화면의 '직접 편집' — 고친 자료를 그대로 받아 새 버전으로 쌓는다
  if (pathname === '/api/workshop/save' && request.method === 'POST') {
    if (!env.WSDB) return wsFail({ error: '워크샵 데이터베이스가 연결되어 있지 않습니다.', detail: 'WSDB 바인딩이 없습니다 — 배포 설정을 확인해 주세요.', status: 503 }, '준비');
    const checked = wsCheckData(await readBody(request));
    if (checked.error) return wsFail({ ...checked, status: 400 }, '내용 확인');
    const saved = await wsSaveDataset(env, checked.data);
    if (saved.error) return wsFail(saved, '저장');
    return json({ ok: true, source: 'editor', ...saved });
  }

  if (pathname === '/api/workshop/versions' && request.method === 'GET') {
    if (!env.WSDB) return json({ versions: [] });
    await ensureWsSchema(env);
    const r = await env.WSDB.prepare(
      'SELECT id, created_at, note, people_count, group_count, is_active FROM ws_dataset ORDER BY id DESC LIMIT 30',
    ).all();
    return json({ versions: r.results ?? [] });
  }

  if (pathname === '/api/workshop/activate' && request.method === 'POST') {
    if (!env.WSDB) return err('워크샵 데이터베이스가 연결되어 있지 않습니다.', 503);
    const { id } = await request.json().catch(() => ({}));
    if (id === undefined || id === null || id === '') return err('버전을 골라 주세요.', 400);
    await ensureWsSchema(env);
    // id 0 = 올린 버전을 모두 쉬게 하고 앱 파일에 들어 있는 원래 자료를 쓴다
    if (Number(id) === 0) {
      await env.WSDB.prepare('UPDATE ws_dataset SET is_active = 0').run();
      wsCache = { id: null, html: null };
      return json({ ok: true, id: 0, file: true });
    }
    const hit = await env.WSDB.prepare('SELECT id FROM ws_dataset WHERE id = ?').bind(id).first();
    if (!hit) return err('그 버전을 찾을 수 없습니다.', 404);
    await env.WSDB.batch([
      env.WSDB.prepare('UPDATE ws_dataset SET is_active = 0'),
      env.WSDB.prepare('UPDATE ws_dataset SET is_active = 1 WHERE id = ?').bind(id),
    ]);
    wsCache = { id: null, html: null };
    return json({ ok: true, id });
  }

  const method = request.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  // ── 인증 API ──────────────────────────────────────────
  // 현재 상태: 초기 설정 여부 + 내 로그인 역할 + 잠금 여부
  if (pathname === '/api/auth/state' && method === 'GET') {
    const hasAdmin = Boolean(await getSetting(db, 'recovery_code'));
    const hasPassword = Boolean(await getSetting(db, 'admin_pw'));
    const session = await getSession(db, request);
    const lockedMinutes = await lockRemaining(db, request);
    return json({ setup: hasAdmin, hasPassword, role: session?.role ?? null, lockedMinutes });
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

  // 로그인 초기화 — 내 컴퓨터에서 직접 돌릴 때만 (인터넷에 배포된 서버에서는 불가)
  // QR·복구 코드를 모두 잃어버렸을 때 쓰는 마지막 수단. 출석 기록과 명단은 그대로 둔다.
  if (pathname === '/api/auth/local-reset' && method === 'POST') {
    // 그 컴퓨터에서 localhost 로 열었을 때만 허용한다.
    // 배포된 주소는 hostname 이 workers.dev 이고, 접속자 IP 도 공인 IP 라 통과하지 못한다.
    const host = new URL(request.url).hostname;
    const ip = request.headers.get('cf-connecting-ip');
    const loopbackHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    const loopbackIp = !ip || ip === '127.0.0.1' || ip === '::1';
    if (!loopbackHost || !loopbackIp) return err('이 컴퓨터에서 직접 실행할 때만 사용할 수 있습니다.', 403);
    await db.batch([
      db.prepare("DELETE FROM settings WHERE key = 'recovery_code'"),
      db.prepare('DELETE FROM sessions'),
      db.prepare('DELETE FROM login_attempts'),
    ]);
    return jsonWithCookie({ ok: true }, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  // 최초 1회: 이미 가지고 있는 관리자 QR 을 이 시스템에 등록해서 그대로 쓴다
  // (아직 아무도 등록하지 않은 시스템에서만 가능 — 등록이 끝나면 거부)
  if (pathname === '/api/auth/claim' && method === 'POST') {
    if (await getSetting(db, 'recovery_code')) return err('이미 초기 설정이 끝났습니다.', 409);
    const body = await readBody(request);
    const payload = String(body?.payload ?? '').trim();
    if (!/^ROLLBOOK-LOGIN:RBL-[A-Z2-9]{16,48}$/.test(payload)) {
      return err('관리자 로그인 QR 이 아닙니다.', 400);
    }
    const token = payload.slice('ROLLBOOK-LOGIN:'.length);
    const admin = await db
      .prepare('SELECT id, name FROM members WHERE is_admin = 1 ORDER BY id LIMIT 1')
      .first();
    if (!admin) return err('관리자로 지정된 인원이 없습니다.', 500);
    // 다른 사람이 같은 토큰을 쓰고 있으면 거부
    const taken = await db.prepare('SELECT id FROM members WHERE login_token = ? AND id != ?').bind(token, admin.id).first();
    if (taken) return err('이미 다른 사람이 쓰고 있는 QR 입니다.', 409);

    const recovery = newRecoveryCode();
    await db.batch([
      db.prepare('UPDATE members SET login_token = ? WHERE id = ?').bind(token, admin.id),
      db.prepare("INSERT INTO settings (key, value) VALUES ('recovery_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(await hashPassword(recovery)),
    ]);
    const cookie = await createSession(db, 'admin', request);
    return jsonWithCookie({ ok: true, role: 'admin', name: admin.name, recovery_code: recovery, claimed: true }, cookie);
  }

  // 비밀번호 로그인 — QR 대신 쓸 수 있는 관리자 로그인
  if (pathname === '/api/auth/password-login' && method === 'POST') {
    const locked = await lockGuard(db, request);
    if (locked) return locked;
    const body = await readBody(request);
    const password = String(body?.password ?? '');
    if (!password) return err('비밀번호를 입력해 주세요.');
    const hash = await getSetting(db, 'admin_pw');
    if (!hash) return err('등록된 관리자 비밀번호가 없습니다. QR 로 로그인해 주세요.', 400);
    if (!(await verifyPassword(password, hash))) {
      const { fails, lockedMinutes } = await recordFail(db, request);
      if (lockedMinutes) {
        return json({ error: `${MAX_FAILS}회 틀려서 로그인이 잠겼습니다. ${lockedMinutes}분 뒤에 다시 시도해 주세요.`, locked: true, minutes: lockedMinutes }, 429);
      }
      return json({ error: `비밀번호가 올바르지 않습니다. (${fails}/${MAX_FAILS}회)`, fails, remaining: MAX_FAILS - fails }, 401);
    }
    await clearFails(db, request);
    await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
    const cookie = await createSession(db, 'admin', request);
    return jsonWithCookie({ ok: true, role: 'admin' }, cookie);
  }

  // 관리자 비밀번호 등록 / 변경 / 해제 (관리자만)
  if (pathname === '/api/auth/admin-password') {
    const session = await getSession(db, request);
    if (session?.role !== 'admin') return json({ error: '로그인이 필요합니다.', auth: true }, 401);
    const hash = await getSetting(db, 'admin_pw');

    if (method === 'GET') return json({ registered: Boolean(hash) });

    if (method === 'POST') {
      const body = await readBody(request);
      const next = String(body?.next ?? '');
      if (next.length < 6) return err('비밀번호는 6자 이상으로 정해 주세요.');
      // 이미 등록돼 있으면 현재 비밀번호를 확인한다
      if (hash) {
        const current = String(body?.current ?? '');
        if (!(await verifyPassword(current, hash))) return err('현재 비밀번호가 올바르지 않습니다.', 401);
      }
      await setSetting(db, 'admin_pw', await hashPassword(next));
      // 비밀번호를 바꾸면 다른 기기의 관리자 세션은 정리하고 내 세션만 남긴다
      await db.prepare("DELETE FROM sessions WHERE role = 'admin' AND token != ?").bind(session.token).run();
      return json({ ok: true, registered: true });
    }

    if (method === 'DELETE') {
      if (!hash) return json({ ok: true, registered: false });
      await db.prepare("DELETE FROM settings WHERE key = 'admin_pw'").run();
      return json({ ok: true, registered: false });
    }
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
    const isBadgeQr = payload.startsWith('ROLLBOOK:');

    // 명찰(출석용) QR 로 로그인 — 관리자로 지정된 사람만, 설정이 켜져 있을 때만
    if (isBadgeQr) {
      if ((await getSetting(db, 'badge_login')) === '0') {
        return err('출석용 QR 입니다. 로그인 QR 을 비춰 주세요.', 400);
      }
      const member = await db
        .prepare('SELECT name, is_admin FROM members WHERE code = ?')
        .bind(payload.slice('ROLLBOOK:'.length))
        .first();
      if (!member) return err('등록되지 않은 QR 입니다.', 400);
      if (!member.is_admin) return err(`${member.name}님은 관리자로 지정되어 있지 않습니다.`, 403);
      await clearFails(db, request);
      await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
      const cookie = await createSession(db, 'admin', request);
      return jsonWithCookie({ ok: true, role: 'admin', name: member.name }, cookie);
    }

    // 로그인 QR 이 아닌 것은 실패로 세지 않는다 — 잘못 비춘 것뿐이므로 안내만
    if (!isAdminQr && !isScannerQr) {
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
  if (pathname === '/api/auth/admins' || (seg[2] === 'admins' && (seg.length === 4 || seg.length === 5))) {
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

    // 가지고 있는 QR 을 이 관리자의 로그인 QR 로 재등록
    if (seg[2] === 'admins' && seg.length === 5 && seg[4] === 'token' && method === 'POST') {
      const memberId = Number(seg[3]);
      if (!Number.isInteger(memberId)) return err('잘못된 회원 ID 입니다.');
      const body = await readBody(request);
      const payload = String(body?.payload ?? '').trim();
      if (!/^ROLLBOOK-LOGIN:RBL-[A-Z2-9]{16,48}$/.test(payload)) {
        if (payload.startsWith('ROLLBOOK-SCANNER:')) return err('스캐너 PC 용 QR 입니다. 관리자 로그인 QR 을 비춰 주세요.');
        if (payload.startsWith('ROLLBOOK:')) return err('출석용 QR 입니다. 관리자 로그인 QR 을 비춰 주세요.');
        return err('관리자 로그인 QR 이 아닙니다.');
      }
      const token = payload.slice('ROLLBOOK-LOGIN:'.length);
      const target = await db.prepare('SELECT id, name FROM members WHERE id = ? AND is_admin = 1').bind(memberId).first();
      if (!target) return err('관리자를 찾을 수 없습니다.', 404);
      const taken = await db.prepare('SELECT name FROM members WHERE login_token = ? AND id != ?').bind(token, memberId).first();
      if (taken) return err(`이미 ${taken.name}님이 쓰고 있는 QR 입니다.`, 409);
      await db.prepare('UPDATE members SET login_token = ? WHERE id = ?').bind(token, memberId).run();
      return json({ ok: true, name: target.name });
    }

    // 새 QR 발급 — 이 관리자의 기존 QR 은 즉시 무효
    if (seg[2] === 'admins' && seg.length === 5 && seg[4] === 'reissue' && method === 'POST') {
      const memberId = Number(seg[3]);
      if (!Number.isInteger(memberId)) return err('잘못된 회원 ID 입니다.');
      const target = await db.prepare('SELECT id, name FROM members WHERE id = ? AND is_admin = 1').bind(memberId).first();
      if (!target) return err('관리자를 찾을 수 없습니다.', 404);
      const token = newLoginToken();
      await db.prepare('UPDATE members SET login_token = ? WHERE id = ?').bind(token, memberId).run();
      return json({ ok: true, name: target.name, login_token: token });
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

  // 명찰 QR 로 로그인 허용 여부 (관리자만)
  if (pathname === '/api/auth/badge-login') {
    const session = await getSession(db, request);
    if (session?.role !== 'admin') return json({ error: '로그인이 필요합니다.', auth: true }, 401);
    if (method === 'GET') {
      return json({ enabled: (await getSetting(db, 'badge_login')) !== '0' });
    }
    if (method === 'POST') {
      const body = await readBody(request);
      const enabled = Boolean(body?.enabled);
      await setSetting(db, 'badge_login', enabled ? '1' : '0');
      return json({ ok: true, enabled });
    }
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
  // 엑셀 일괄 등록 — 같은 사람이면 부서·직함이 바뀐 것으로 보고 최신 자료로 갱신한다.
  // QR 코드 값은 그대로 두므로 이미 나눠 준 명찰은 계속 쓸 수 있다.
  if (pathname === '/api/members/bulk' && method === 'POST') {
    const body = await readBody(request);
    const list = Array.isArray(body?.members) ? body.members : [];
    if (!list.length) return err('등록할 인원이 없습니다.');
    if (list.length > 1000) return err('한 번에 1,000명까지 등록할 수 있습니다.');

    const { results: existing } = await db.prepare('SELECT id, name, title, dept FROM members').all();
    // 이름별로 묶어 둔다 — 띄어쓰기를 뺀 이름을 기준으로 (동명이인 판단에 쓴다)
    const byName = new Map();
    for (const m of existing) {
      const k = nameKey(m.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push({ ...m });
    }

    const stmts = [];
    let added = 0;      // 새로 등록
    let updated = 0;    // 부서·직함이 바뀌어 갱신
    let unchanged = 0;  // 이미 같은 내용
    let skipped = 0;    // 이름이 비어 있는 줄
    const ambiguous = []; // 동명이인이라 판단할 수 없는 사람

    for (const m of list) {
      const name = String(m?.name ?? '').trim();
      const title = String(m?.title ?? '').trim();
      const dept = String(m?.dept ?? '').trim();
      if (!name) { skipped++; continue; }

      const key = nameKey(name);
      const sameName = byName.get(key) ?? [];

      // 1) 이름·부서가 모두 같으면 그 사람이 확실하다
      let target = sameName.find((x) => x.dept === dept);
      if (!target) {
        // 이번 파일에서 아직 짝지어지지 않은 같은 이름들
        const free = sameName.filter((x) => !x.used);
        if (free.length === 1) {
          // 그 이름이 한 명뿐 → 부서·직함이 바뀐 것으로 보고 갱신
          target = free[0];
        } else if (free.length > 1) {
          // 동명이인이 여럿인데 부서도 안 맞음 — 잘못 합칠 수 있으니 건드리지 않는다
          if (!ambiguous.includes(name)) ambiguous.push(name);
          continue;
        }
        // free 가 0 이면: 같은 파일 안에 이미 그 이름을 쓴 줄이 있다는 뜻 → 동명이인이므로 새로 등록
      }

      if (!target) {
        sameName.push({ id: null, name, title, dept, used: true });
        byName.set(key, sameName);
        stmts.push(db.prepare('INSERT INTO members (name, title, dept, code) VALUES (?, ?, ?, ?)').bind(name, title, dept, newMemberCode()));
        added++;
        continue;
      }

      target.used = true;
      if (target.name === name && target.title === title && target.dept === dept) { unchanged++; continue; }
      // 최신 자료로 갱신 — 이름 표기(띄어쓰기 등)도 새 파일 기준으로 (QR 코드 값은 유지)
      if (target.id != null) {
        stmts.push(db.prepare('UPDATE members SET name = ?, title = ?, dept = ? WHERE id = ?').bind(name, title, dept, target.id));
      }
      target.name = name;
      target.title = title;
      target.dept = dept;
      updated++;
    }

    if (stmts.length) await db.batch(stmts);
    return json({ added, updated, unchanged, skipped, ambiguous });
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
