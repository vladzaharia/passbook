-- Entitlements (design-multi-tenancy.md section 2): what an organization may use. Presets are rows of data
-- (seeded from src/shared/contracts/entitlements.ts; a test holds the two equal); an org points at one and may carry
-- overrides, with an optional expiry. One view resolves a key: override (unexpired) over preset. A missing row
-- resolves to nothing and denies. Only platform grants write these tables (RESTRICTED_TABLES); an org cannot.
CREATE TABLE entitlement_preset_meta (
  preset TEXT PRIMARY KEY CHECK (preset NOT GLOB '*[^a-z0-9_]*' AND length(preset) BETWEEN 1 AND 32),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  is_plan INTEGER NOT NULL DEFAULT 0 CHECK (is_plan IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE entitlement_presets (
  preset TEXT NOT NULL REFERENCES entitlement_preset_meta (preset) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value) AND value = json(value)),
  PRIMARY KEY (preset, key)
);

CREATE TABLE org_entitlements (
  org_id TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  preset TEXT NOT NULL REFERENCES entitlement_preset_meta (preset),
  trial_ends_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE INDEX org_entitlements_preset ON org_entitlements (preset);

CREATE TABLE org_entitlement_overrides (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value) AND value = json(value)),
  note TEXT CHECK (note IS NULL OR length(note) <= 200),
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (org_id, key)
);

-- The one place a value is read: the unexpired override, else the org's preset value. An override of a key
-- the preset lacks resolves to nothing, so a key must be in every preset (a test holds that).
CREATE VIEW org_entitlement_values AS
  SELECT e.org_id, p.key, COALESCE(o.value, p.value) AS value
  FROM org_entitlements e
  JOIN entitlement_presets p ON p.preset = e.preset
  LEFT JOIN org_entitlement_overrides o ON o.org_id = e.org_id AND o.key = p.key
    AND (o.expires_at IS NULL OR o.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER));

-- An org keeps its row while it exists (the cascade runs after the org is gone), and the row never moves org.
CREATE TRIGGER org_entitlements_keep BEFORE DELETE ON org_entitlements
WHEN EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id)
BEGIN SELECT RAISE(ABORT, 'an organization keeps its entitlements row'); END;
CREATE TRIGGER org_entitlements_org_fixed BEFORE UPDATE OF org_id ON org_entitlements
BEGIN SELECT RAISE(ABORT, 'org_entitlements.org_id is fixed'); END;
CREATE TRIGGER org_entitlement_overrides_org_fixed BEFORE UPDATE OF org_id, key ON org_entitlement_overrides
BEGIN SELECT RAISE(ABORT, 'an override keeps its org and key'); END;

INSERT INTO entitlement_preset_meta (preset, label, is_plan, revision, updated_at) VALUES
  ('legacy', 'Legacy', 0, 1, 1795046400000),
  ('trial', 'Trial', 0, 1, 1795046400000),
  ('standard', 'Standard', 0, 1, 1795046400000);

INSERT INTO entitlement_presets (preset, key, value) VALUES
  ('legacy', 'api', '"full"'),
  ('legacy', 'api.rateTier', '"bulk"'),
  ('legacy', 'api.keys', 'null'),
  ('legacy', 'apps', '1'),
  ('legacy', 'webhooks', '1'),
  ('legacy', 'webhooks.endpoints', 'null'),
  ('legacy', 'connections', 'null'),
  ('legacy', 'connectors', '["*"]'),
  ('legacy', 'wallet.google', '1'),
  ('legacy', 'wallet.samsung', '1'),
  ('legacy', 'print', '1'),
  ('legacy', 'nfc', '"secure"'),
  ('legacy', 'scanning.devices', 'null'),
  ('legacy', 'join.perDay', 'null'),
  ('legacy', 'messages.perDay', 'null'),
  ('legacy', 'passes.live', 'null'),
  ('legacy', 'passes.test', 'null'),
  ('legacy', 'templates', 'null'),
  ('legacy', 'templates.uploads', '1'),
  ('legacy', 'templates.stylesBlocked', '[]'),
  ('legacy', 'email.perDay', 'null'),
  ('legacy', 'members', 'null'),
  ('legacy', 'brand.mark', '"full"'),
  ('legacy', 'domains', '0'),
  ('legacy', 'identity.own', '1'),
  ('trial', 'api', '"full"'),
  ('trial', 'api.rateTier', '"standard"'),
  ('trial', 'api.keys', '2'),
  ('trial', 'apps', '0'),
  ('trial', 'webhooks', '0'),
  ('trial', 'webhooks.endpoints', '1'),
  ('trial', 'connections', '1'),
  ('trial', 'connectors', '["csv-url","webhook-push/*"]'),
  ('trial', 'wallet.google', '0'),
  ('trial', 'wallet.samsung', '0'),
  ('trial', 'print', '0'),
  ('trial', 'nfc', '"off"'),
  ('trial', 'scanning.devices', '2'),
  ('trial', 'join.perDay', '100'),
  ('trial', 'messages.perDay', '3'),
  ('trial', 'passes.live', '100'),
  ('trial', 'passes.test', '50'),
  ('trial', 'templates', '3'),
  ('trial', 'templates.uploads', '0'),
  ('trial', 'templates.stylesBlocked', '["boardingPass"]'),
  ('trial', 'email.perDay', '100'),
  ('trial', 'members', '3'),
  ('trial', 'brand.mark', '"full"'),
  ('trial', 'domains', '0'),
  ('trial', 'identity.own', '0'),
  ('standard', 'api', '"full"'),
  ('standard', 'api.rateTier', '"high"'),
  ('standard', 'api.keys', '10'),
  ('standard', 'apps', '1'),
  ('standard', 'webhooks', '1'),
  ('standard', 'webhooks.endpoints', '10'),
  ('standard', 'connections', '10'),
  ('standard', 'connectors', '["*"]'),
  ('standard', 'wallet.google', '1'),
  ('standard', 'wallet.samsung', '1'),
  ('standard', 'print', '1'),
  ('standard', 'nfc', '"basic"'),
  ('standard', 'scanning.devices', '20'),
  ('standard', 'join.perDay', '1000'),
  ('standard', 'messages.perDay', '20'),
  ('standard', 'passes.live', '5000'),
  ('standard', 'passes.test', '500'),
  ('standard', 'templates', '25'),
  ('standard', 'templates.uploads', '1'),
  ('standard', 'templates.stylesBlocked', '[]'),
  ('standard', 'email.perDay', '500'),
  ('standard', 'members', '25'),
  ('standard', 'brand.mark', '"quiet"'),
  ('standard', 'domains', '1'),
  ('standard', 'identity.own', '1');

-- M4: every existing org keeps what it has (preset legacy). Orgs created later get a row in the create batch.
INSERT INTO org_entitlements (org_id, preset, updated_at)
  SELECT id, 'legacy', 1795046400000 FROM orgs WHERE id NOT IN (SELECT org_id FROM org_entitlements);

-- Grant refusals gain 'entitlement' and 'limit' (as 0106 added 'proof').
DROP TRIGGER authority_grants_deny;
CREATE TRIGGER authority_grants_deny BEFORE INSERT ON authority_grants WHEN NEW.denied IS NOT NULL
BEGIN SELECT CASE NEW.denied
  WHEN 'org' THEN RAISE(ABORT, 'authority_denied:org') WHEN 'actor' THEN RAISE(ABORT, 'authority_denied:actor')
  WHEN 'staff' THEN RAISE(ABORT, 'authority_denied:staff')
  WHEN 'config' THEN RAISE(ABORT, 'authority_denied:config') WHEN 'lineage' THEN RAISE(ABORT, 'authority_denied:lineage')
  WHEN 'stale' THEN RAISE(ABORT, 'authority_denied:stale') WHEN 'release' THEN RAISE(ABORT, 'authority_denied:release')
  WHEN 'retention' THEN RAISE(ABORT, 'authority_denied:retention') WHEN 'proof' THEN RAISE(ABORT, 'authority_denied:proof')
  WHEN 'entitlement' THEN RAISE(ABORT, 'authority_denied:entitlement') WHEN 'limit' THEN RAISE(ABORT, 'authority_denied:limit')
  ELSE RAISE(ABORT, 'authority_denied:other') END; END;
