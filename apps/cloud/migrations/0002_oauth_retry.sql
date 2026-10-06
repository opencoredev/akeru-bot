-- Retry delivery without exchanging a single-use provider code twice.
-- Completion results are encrypted with a key derived from the secret OAuth state.
ALTER TABLE oauth_flows ADD COLUMN completion_ciphertext TEXT;
ALTER TABLE oauth_flows ADD COLUMN processing_until TEXT;
