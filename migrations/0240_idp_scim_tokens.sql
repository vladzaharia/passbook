-- SCIM receiver bearer tokens (Polaris ID auto-setup, AS-3). Only the SHA-256 of a token is stored; nothing
-- ever needs the plaintext again, rotation mints a new one. One active and one pending token at most. While a
-- row is active the SCIM_BEARER_TOKEN secret is ignored.
CREATE TABLE idp_scim_tokens (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'retired')),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at INTEGER,
  last_auth_at INTEGER,
  created_by TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idp_scim_tokens_one_active ON idp_scim_tokens (state) WHERE state = 'active';
CREATE UNIQUE INDEX idp_scim_tokens_one_pending ON idp_scim_tokens (state) WHERE state = 'pending';

CREATE TRIGGER idp_scim_tokens_immutable BEFORE UPDATE ON idp_scim_tokens
WHEN NEW.id IS NOT OLD.id OR NEW.token_sha256 IS NOT OLD.token_sha256 OR NEW.created_at IS NOT OLD.created_at
  OR NEW.created_by IS NOT OLD.created_by
  OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at)
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
  OR (OLD.state = 'retired' AND NEW.state IS NOT 'retired')
  OR (OLD.state = 'active' AND NEW.state NOT IN ('active', 'retired'))
  OR (NEW.state = 'active' AND OLD.state IS NOT 'active' AND OLD.state IS NOT 'pending')
BEGIN SELECT RAISE(ABORT, 'immutable scim token'); END;
-- Retention removes retired rows only.
CREATE TRIGGER idp_scim_tokens_no_delete BEFORE DELETE ON idp_scim_tokens
WHEN OLD.state IS NOT 'retired'
BEGIN SELECT RAISE(ABORT, 'immutable scim token'); END;
