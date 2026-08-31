CREATE TABLE akeru_feedback_inbox (
  feedback_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  install_hash TEXT NOT NULL,
  coarse_ip_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX idx_akeru_feedback_ip_received
  ON akeru_feedback_inbox(coarse_ip_hash, received_at);
CREATE INDEX idx_akeru_feedback_install_received
  ON akeru_feedback_inbox(install_hash, received_at);
CREATE INDEX idx_akeru_feedback_duplicate
  ON akeru_feedback_inbox(install_hash, content_hash, received_at);
CREATE INDEX idx_akeru_feedback_expires
  ON akeru_feedback_inbox(expires_at);
