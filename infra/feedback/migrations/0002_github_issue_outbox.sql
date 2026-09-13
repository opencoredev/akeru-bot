ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_issue_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (github_issue_status IN ('pending', 'delivering', 'unknown', 'failed', 'delivered'));

ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_issue_number INTEGER;

ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_issue_url TEXT;

ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_delivery_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_next_attempt_at TEXT;

ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_lease_expires_at TEXT;

ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_last_error_code TEXT;

CREATE INDEX idx_akeru_feedback_github_delivery
  ON akeru_feedback_inbox(
    github_issue_status,
    github_next_attempt_at,
    github_lease_expires_at,
    received_at
  );

CREATE INDEX idx_akeru_feedback_coarse_duplicate
  ON akeru_feedback_inbox(coarse_ip_hash, content_hash, received_at);
