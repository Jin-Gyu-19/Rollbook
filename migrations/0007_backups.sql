-- 자동·수동 백업 스냅샷 (명단·출석부·출석기록을 JSON 으로 통째 보관)
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL DEFAULT 'auto',   -- 'auto' = 매일 자동, 'manual' = 직접 만듦
  members INTEGER NOT NULL DEFAULT 0,
  sheets INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at DESC);
