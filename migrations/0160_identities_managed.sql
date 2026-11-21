-- Managed identities, part 1: guards and certificate history.
-- Installed passes key on the pass type and team, so they never change after insert.
CREATE TRIGGER signing_identities_pti_immutable BEFORE UPDATE OF pass_type_identifier, team_identifier
ON signing_identities
WHEN OLD.pass_type_identifier IS NOT NEW.pass_type_identifier
  OR OLD.team_identifier IS NOT NEW.team_identifier
BEGIN
  SELECT RAISE(ABORT, 'IDENTITY_PTI_IMMUTABLE');
END;

-- INSERT OR REPLACE deletes and reinserts without an UPDATE (and cascades registrations): refuse a
-- reinsert that changes an id's identifiers or takes another row's pass type.
CREATE TRIGGER signing_identities_pti_insert_guard BEFORE INSERT ON signing_identities
WHEN EXISTS (
  SELECT 1 FROM signing_identities
  WHERE (id = NEW.id
      AND (pass_type_identifier IS NOT NEW.pass_type_identifier OR team_identifier IS NOT NEW.team_identifier))
    OR (pass_type_identifier = NEW.pass_type_identifier AND id IS NOT NEW.id)
)
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
  identity_id TEXT NOT NULL REFERENCES signing_identities (id) ON UPDATE CASCADE ON DELETE CASCADE,
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
  CASE source WHEN 'env' THEN 'env' ELSE 'upload' END, 'active',
  COALESCE((SELECT rotated_at FROM credentials c WHERE c.id = signing_identities.credential_id), created_at),
  COALESCE((SELECT rotated_at FROM credentials c WHERE c.id = signing_identities.credential_id), created_at)
FROM signing_identities WHERE cert_sha256 IS NOT NULL;

-- Every later certificate (upload, rotation, env change) lands in the history in the same statement.
-- Both are idempotent: a row for this certificate already written as active (by a provisioner that
-- records its own history) is never duplicated.
CREATE TRIGGER identity_certificates_on_insert AFTER INSERT ON signing_identities
WHEN NEW.cert_sha256 IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM identity_certificates
    WHERE identity_id = NEW.id AND cert_sha256 = NEW.cert_sha256 AND state = 'active')
BEGIN
  INSERT INTO identity_certificates
    (id, identity_id, credential_id, cert_sha256, not_before, not_after, origin, state, created_at, activated_at)
  VALUES ('idc-' || lower(hex(randomblob(16))), NEW.id, NEW.credential_id, NEW.cert_sha256, NEW.not_before,
    NEW.not_after, CASE NEW.source WHEN 'env' THEN 'env' ELSE 'upload' END, 'active',
    NEW.created_at, NEW.created_at);
END;

CREATE TRIGGER identity_certificates_on_rotate AFTER UPDATE OF cert_sha256 ON signing_identities
WHEN NEW.cert_sha256 IS NOT NULL AND NEW.cert_sha256 IS NOT OLD.cert_sha256
  AND NOT EXISTS (SELECT 1 FROM identity_certificates
    WHERE identity_id = NEW.id AND cert_sha256 = NEW.cert_sha256 AND state = 'active')
BEGIN
  UPDATE identity_certificates
    SET state = 'superseded', ended_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE identity_id = NEW.id AND state = 'active';
  INSERT INTO identity_certificates
    (id, identity_id, credential_id, cert_sha256, not_before, not_after, origin, state, created_at, activated_at)
  VALUES ('idc-' || lower(hex(randomblob(16))), NEW.id, NEW.credential_id, NEW.cert_sha256, NEW.not_before,
    NEW.not_after, CASE NEW.source WHEN 'env' THEN 'env' ELSE 'upload' END, 'active',
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
