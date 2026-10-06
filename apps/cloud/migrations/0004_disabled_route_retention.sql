ALTER TABLE channel_routes ADD COLUMN disabled_at TEXT;
UPDATE channel_routes SET disabled_at = COALESCE(
  (SELECT revoked_at FROM environments WHERE id = channel_routes.environment_id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) WHERE disabled = 1;
CREATE INDEX idx_channel_routes_disabled_at ON channel_routes(disabled, disabled_at);
CREATE INDEX idx_channel_routes_account_list ON channel_routes(user_id, disabled, created_at DESC, route_id DESC);
