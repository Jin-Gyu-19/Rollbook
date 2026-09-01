-- 로그인 실패 잠금 (5회 실패 시 10분)
CREATE TABLE IF NOT EXISTS login_attempts (
  client TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

-- 비밀번호·접속코드 로그인은 QR 로그인으로 대체되었다
DELETE FROM settings WHERE key IN ('admin_pw', 'scanner_code');
