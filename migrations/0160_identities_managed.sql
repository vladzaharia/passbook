-- Managed identities, part 1: guards and certificate history.
-- Installed passes key on the pass type and team, so they never change after insert.
CREATE TRIGGER signing_identities_pti_immutable BEFORE UPDATE OF pass_type_identifier, team_identifier
ON signing_identities
WHEN OLD.pass_type_identifier IS NOT NEW.pass_type_identifier
  OR OLD.team_identifier IS NOT NEW.team_identifier
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_PTI_IMMUTABLE');
END;

ALTER TABLE signing_identities ADD COLUMN provenance TEXT NOT NULL DEFAULT 'own'
  CHECK (provenance IN ('platform', 'managed', 'own'));
-- 0 refuses new passes; updates, pushes and the web service keep working for passes already issued.
ALTER TABLE signing_identities ADD COLUMN issuing INTEGER NOT NULL DEFAULT 1 CHECK (issuing IN (0, 1));
UPDATE signing_identities SET provenance = 'platform' WHERE org_id IS NULL;

CREATE TABLE identity_certificates (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES signing_identities (id) ON DELETE CASCADE,
  credential_id TEXT REFERENCES credentials (id) ON DELETE SET NULL,
  cert_sha256 TEXT,
  not_before INTEGER,
  not_after INTEGER,
  asc_certificate_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('upload', 'asc', 'csr', 'env')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'superseded', 'revoked', 'failed')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  ended_at INTEGER
);
CREATE UNIQUE INDEX identity_certificates_one_active ON identity_certificates (identity_id) WHERE state = 'active';
CREATE INDEX identity_certificates_identity ON identity_certificates (identity_id, created_at);
CREATE INDEX identity_certificates_credential ON identity_certificates (credential_id);

INSERT INTO identity_certificates
  (id, identity_id, credential_id, cert_sha256, not_before, not_after, origin, state, created_at, activated_at)
SELECT 'backfill-' || id, id, credential_id, cert_sha256, not_before, not_after,
  CASE source WHEN 'env' THEN 'env' ELSE 'upload' END, 'active', created_at, created_at
FROM signing_identities WHERE cert_sha256 IS NOT NULL;
