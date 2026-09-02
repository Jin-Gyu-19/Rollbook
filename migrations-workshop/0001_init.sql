-- 워크샵 관리 전용 데이터베이스 (출석 체크 DB 와 완전히 분리)
-- 참석 명단·조배정·프로그램·석식 배정을 한 벌씩 버전으로 보관하고,
-- is_active = 1 인 한 벌을 참석자 화면에 내보낸다.
CREATE TABLE IF NOT EXISTS ws_dataset (
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
);
CREATE INDEX IF NOT EXISTS idx_ws_dataset_active ON ws_dataset(is_active, id DESC);
