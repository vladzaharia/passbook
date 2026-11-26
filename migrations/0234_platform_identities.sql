-- Platform identities (PI-2): what a signing identity is for, and `devtest` held for the platform.
-- Only 'passes' identities sign for orgs; the resolver's forOrg refuses the rest.
ALTER TABLE signing_identities ADD COLUMN purpose TEXT NOT NULL DEFAULT 'passes'
  CHECK (purpose IN ('passes', 'device_test'));
-- A taken handle makes this a no-op (identity_handles_no_replace). If an org already holds `devtest`,
-- the next statement fails the migration so the owner decides.
INSERT INTO identity_handles (handle, org_id, reserved_at) VALUES ('devtest', NULL, 0);
SELECT json(CASE WHEN EXISTS (SELECT 1 FROM identity_handles WHERE handle = 'devtest' AND org_id IS NOT NULL)
  THEN 'devtest is held by an org' ELSE '{}' END);
