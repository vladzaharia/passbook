-- Platform identities (PI-2): what a signing identity is for, and `devtest` held for the platform.
-- Only 'passes' identities sign for orgs; the resolver's forOrg refuses the rest.
-- The abort check runs first, so a refused apply leaves nothing behind. It fails the migration when an
-- org already holds `devtest`, or when an uploaded identity already holds either platform pass type.
SELECT json(CASE
  WHEN EXISTS (SELECT 1 FROM identity_handles WHERE handle = 'devtest' AND org_id IS NOT NULL)
    THEN 'devtest is held by an org'
  WHEN EXISTS (SELECT 1 FROM signing_identities
    WHERE pass_type_identifier IN ('pass.mobile.passbook', 'pass.mobile.passbook.devtest'))
    THEN 'a platform pass type is already held by an identity'
  ELSE '{}' END);
ALTER TABLE signing_identities ADD COLUMN purpose TEXT NOT NULL DEFAULT 'passes'
  CHECK (purpose IN ('passes', 'device_test'));
-- Purpose is set when the row is made; it never changes.
CREATE TRIGGER signing_identities_purpose_fixed BEFORE UPDATE OF purpose ON signing_identities
WHEN OLD.purpose IS NOT NEW.purpose
BEGIN SELECT RAISE(ABORT, 'signing_identities.purpose is immutable'); END;
-- A taken handle makes this a no-op (identity_handles_no_replace).
INSERT INTO identity_handles (handle, org_id, reserved_at) VALUES ('devtest', NULL, 0);
