-- Console and developer work needs a strong sign-in (Polaris ID or break-glass). Every active member
-- who may reach a console today keeps an email session's console until `auth.consoleEmailUntil`
-- (strong sessions never read it); new members never get grace.
CREATE TABLE console_email_grace (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
INSERT INTO console_email_grace (user_id, created_at)
SELECT u.id, CAST(unixepoch() AS INTEGER) * 1000 FROM users u
WHERE u.status = 'active'
  AND EXISTS (SELECT 1 FROM org_memberships m WHERE m.user_id = u.id AND m.revoked_at IS NULL);
-- Grace ends 21 days after this migration. A database with nobody in grace (a fresh one) enforces at once.
INSERT INTO settings (scope, key, value, updated_at)
SELECT 'platform', 'auth.consoleEmailUntil', CAST((CAST(unixepoch() AS INTEGER) + 21 * 86400) * 1000 AS TEXT),
  CAST(unixepoch() AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM console_email_grace);

-- A sign-in link mailed with an invitation no longer joins an org (joining needs Polaris ID): end them.
UPDATE magic_links SET expires_at = created_at WHERE invitation_id IS NOT NULL AND consumed_at IS NULL;

-- How the key's creator signed in; NULL for keys made before this migration or by another key.
ALTER TABLE api_keys ADD COLUMN created_amr TEXT CHECK (created_amr IS NULL OR created_amr IN ('oidc', 'magic_link', 'breakglass'));
CREATE TRIGGER api_keys_created_amr_immutable BEFORE UPDATE OF created_amr ON api_keys
WHEN NEW.created_amr IS NOT OLD.created_amr
BEGIN SELECT RAISE(ABORT, 'api key created_amr is immutable'); END;

-- When the person last proved themselves to the identity provider (ms).
ALTER TABLE sessions ADD COLUMN auth_time INTEGER;
DROP TRIGGER sessions_authority_immutable;
CREATE TRIGGER sessions_authority_immutable BEFORE UPDATE ON sessions
WHEN NEW.id_hash IS NOT OLD.id_hash OR NEW.user_id IS NOT OLD.user_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.roles IS NOT OLD.roles OR NEW.amr IS NOT OLD.amr OR NEW.auth_time IS NOT OLD.auth_time
BEGIN
  SELECT RAISE(ABORT, 'session authority is immutable');
END;

-- A callback that saw no passkey restarts the flow once with prompt=login.
ALTER TABLE oidc_flows ADD COLUMN retried INTEGER NOT NULL DEFAULT 0 CHECK (retried IN (0, 1));
