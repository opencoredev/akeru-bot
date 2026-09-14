ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_delivery_eligible INTEGER NOT NULL DEFAULT 0
  CHECK (github_delivery_eligible IN (0, 1));

ALTER TABLE akeru_feedback_inbox
  ADD COLUMN github_delivery_claim_id TEXT;

DROP INDEX idx_akeru_feedback_github_delivery;

CREATE INDEX idx_akeru_feedback_github_delivery
  ON akeru_feedback_inbox(
    github_delivery_eligible,
    github_issue_status,
    github_next_attempt_at,
    github_lease_expires_at,
    expires_at,
    received_at
  );
