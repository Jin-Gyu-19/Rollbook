-- 출석부 목록 순서 (관리자가 직접 바꿀 수 있게)
ALTER TABLE sheets ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
