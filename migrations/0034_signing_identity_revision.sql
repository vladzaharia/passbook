-- Existing identities start at 1. A database-wide sequence prevents a deleted and
-- recreated identity from ever regaining a previously observed revision.
ALTER TABLE signing_identities ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision > 0);
ALTER TABLE signing_identities ADD COLUMN env_material_sha256 TEXT;

CREATE TABLE signing_identity_revision_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0)
);
INSERT INTO signing_identity_revision_sequence (id, revision) VALUES (1, 1);

CREATE TRIGGER signing_identity_revision_insert AFTER INSERT ON signing_identities
BEGIN
  UPDATE signing_identity_revision_sequence SET revision = revision + 1 WHERE id = 1;
  UPDATE signing_identities SET revision = (SELECT revision FROM signing_identity_revision_sequence WHERE id = 1)
    WHERE id = NEW.id;
END;

CREATE TRIGGER signing_identity_revision_update AFTER UPDATE OF
  id, org_id, pass_type_identifier, team_identifier, source, env_prefix, credential_id,
  cert_pem, cert_sha256, not_before, not_after, apns_binding, nfc_enabled, is_default, env_material_sha256
ON signing_identities
WHEN OLD.id IS NOT NEW.id
  OR OLD.org_id IS NOT NEW.org_id
  OR OLD.pass_type_identifier IS NOT NEW.pass_type_identifier
  OR OLD.team_identifier IS NOT NEW.team_identifier
  OR OLD.source IS NOT NEW.source
  OR OLD.env_prefix IS NOT NEW.env_prefix
  OR OLD.credential_id IS NOT NEW.credential_id
  OR OLD.cert_pem IS NOT NEW.cert_pem
  OR OLD.cert_sha256 IS NOT NEW.cert_sha256
  OR OLD.not_before IS NOT NEW.not_before
  OR OLD.not_after IS NOT NEW.not_after
  OR OLD.apns_binding IS NOT NEW.apns_binding
  OR OLD.nfc_enabled IS NOT NEW.nfc_enabled
  OR OLD.is_default IS NOT NEW.is_default
  OR OLD.env_material_sha256 IS NOT NEW.env_material_sha256
BEGIN
  UPDATE signing_identity_revision_sequence SET revision = revision + 1 WHERE id = 1;
  UPDATE signing_identities SET revision = (SELECT revision FROM signing_identity_revision_sequence WHERE id = 1)
    WHERE id = NEW.id;
END;

-- In-place credential changes are uncommon, but must invalidate proofs too.
CREATE TRIGGER signing_identity_revision_credential_update AFTER UPDATE OF
  org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint
ON credentials
WHEN (OLD.org_id IS NOT NEW.org_id OR OLD.kind IS NOT NEW.kind
  OR OLD.kek_version IS NOT NEW.kek_version OR OLD.iv IS NOT NEW.iv
  OR OLD.wrapped_dek IS NOT NEW.wrapped_dek OR OLD.ciphertext IS NOT NEW.ciphertext
  OR OLD.fingerprint IS NOT NEW.fingerprint)
  AND EXISTS (SELECT 1 FROM signing_identities WHERE credential_id = NEW.id)
BEGIN
  UPDATE signing_identity_revision_sequence SET revision = revision + 1 WHERE id = 1;
  UPDATE signing_identities SET revision = (SELECT revision FROM signing_identity_revision_sequence WHERE id = 1)
    WHERE credential_id = NEW.id;
END;
