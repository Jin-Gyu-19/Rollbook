-- 같은 내용을 두 번 저장하지 않도록 내용 지문(SHA-256)을 남긴다
ALTER TABLE backups ADD COLUMN fingerprint TEXT;
