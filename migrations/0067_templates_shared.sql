-- A platform upload (no org) is staged until a platform admin shares it with all orgs. Existing
-- uploads stay visible, so production orgs keep what they see today. Baked templates are always shared.
ALTER TABLE templates ADD COLUMN shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1));
UPDATE templates SET shared = 1 WHERE org_id IS NULL AND origin != 'baked';
