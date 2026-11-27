-- CLI sign-in (`passbook login`): a device-code session, and the personal Test key (`pbcli_test_…`) it hands over.
-- `origin` marks a key made by a CLI sign-in; it resolves through the same store, with its own route allowlist.
ALTER TABLE api_keys ADD COLUMN origin TEXT NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'cli'));

-- `device_hash` is the SHA-256 of the device code, `code_mac` the HMAC of the user code (label cli-user-code.v1);
-- neither is ever stored in the clear. The key's secret is derived from the session (never stored), so the one
-- poll that wins `consumed_at` can hand it over. `token_revoked_at` ends the key (the trigger below).
CREATE TABLE cli_sessions (
  id TEXT PRIMARY KEY,
  device_hash TEXT NOT NULL UNIQUE,
  code_mac TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied')),
  client TEXT NOT NULL CHECK (json_valid(client)),
  account_hint TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip_prefix TEXT,
  country TEXT,
  city TEXT,
  interval_s INTEGER NOT NULL DEFAULT 5,
  last_poll_at INTEGER,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  org_id TEXT REFERENCES orgs (id) ON DELETE CASCADE,
  approved_at INTEGER,
  approve_country TEXT,
  mismatch_at INTEGER,
  token_id TEXT REFERENCES api_keys (id) ON DELETE SET NULL,
  consumed_at INTEGER,
  token_revoked_at INTEGER,
  token_revoke_reason TEXT
);
-- A code is unique among pending sessions.
CREATE UNIQUE INDEX cli_sessions_pending_code ON cli_sessions (code_mac) WHERE state = 'pending';
CREATE INDEX cli_sessions_token ON cli_sessions (token_id) WHERE token_id IS NOT NULL;
CREATE INDEX cli_sessions_user ON cli_sessions (user_id) WHERE token_id IS NOT NULL;
CREATE INDEX cli_sessions_expiry ON cli_sessions (expires_at);

CREATE TRIGGER cli_sessions_revoke_key AFTER UPDATE OF token_revoked_at ON cli_sessions
WHEN NEW.token_revoked_at IS NOT NULL AND OLD.token_revoked_at IS NULL AND NEW.token_id IS NOT NULL
BEGIN
  UPDATE api_keys SET revoked_at = NEW.token_revoked_at WHERE id = NEW.token_id AND revoked_at IS NULL;
END;
