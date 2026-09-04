-- 회계사 등록번호(KICPA) — 출석집계표에 '등록번호' 로 나간다
ALTER TABLE members ADD COLUMN cpa_no TEXT NOT NULL DEFAULT '';
