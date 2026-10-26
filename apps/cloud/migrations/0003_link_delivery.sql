ALTER TABLE link_codes ADD COLUMN caller_hash TEXT;
ALTER TABLE link_codes ADD COLUMN environment_id TEXT;
ALTER TABLE link_codes ADD COLUMN token_hash TEXT;
ALTER TABLE link_codes ADD COLUMN token_ciphertext TEXT;
ALTER TABLE link_codes ADD COLUMN delivery_expires_at TEXT;
CREATE INDEX link_codes_caller ON link_codes(caller_hash);
CREATE TABLE link_starts (caller_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX link_starts_caller ON link_starts(caller_hash, created_at);
