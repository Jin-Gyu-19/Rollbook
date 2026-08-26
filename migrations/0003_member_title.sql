-- 인원 직함 컬럼 추가
ALTER TABLE members ADD COLUMN title TEXT NOT NULL DEFAULT '';
