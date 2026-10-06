-- Akeru Cloud stores accounts, links, and routing metadata only. It never stores
-- message content, channel credentials, or raw tokens; token columns hold SHA-256 hashes.

CREATE TABLE users (
  clerk_user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(clerk_user_id),
  name TEXT NOT NULL,
  server_version TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_environments_user ON environments(user_id);

CREATE TABLE link_codes (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  environment_name TEXT NOT NULL,
  server_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_user_id TEXT,
  denied INTEGER NOT NULL DEFAULT 0 CHECK (denied IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_link_codes_expires ON link_codes(expires_at);

CREATE TABLE channel_routes (
  route_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  user_id TEXT NOT NULL REFERENCES users(clerk_user_id),
  label TEXT NOT NULL,
  external_app_id TEXT,
  external_workspace_id TEXT,
  external_workspace_name TEXT,
  created_at TEXT NOT NULL,
  last_event_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

CREATE INDEX idx_channel_routes_user ON channel_routes(user_id);
CREATE INDEX idx_channel_routes_environment ON channel_routes(environment_id);

CREATE TABLE oauth_flows (
  flow_id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  route_id TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_flows_expires ON oauth_flows(expires_at);

CREATE TABLE daily_usage (
  route_id TEXT NOT NULL,
  day TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (route_id, day)
);
