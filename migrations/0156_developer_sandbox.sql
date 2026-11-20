-- Developer sandbox (PX7). A developer org is a person's own test bench: it never holds Live and never issues
-- a real wallet pass. `kind` is set when the org is made and never changes; the principal SQL refuses Live for
-- it (authority-principal.ts), and the triggers below refuse a Live key or pass as a second line.
ALTER TABLE orgs ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'developer'));

CREATE TRIGGER orgs_kind_immutable BEFORE UPDATE OF kind ON orgs
WHEN NEW.kind IS NOT OLD.kind
BEGIN SELECT RAISE(ABORT, 'org kind is immutable'); END;

CREATE TRIGGER api_keys_developer_test_only BEFORE INSERT ON api_keys
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live key'); END;

CREATE TRIGGER passes_developer_test_only BEFORE INSERT ON passes
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live pass'); END;

-- One sandbox per person. The funnel columns are set once (first call, first pass, first preview, first Live key
-- in any org); `closed_at` is set when the sandbox closes, idle or by an admin, and the row stays so a person
-- cannot make a second one.
CREATE TABLE developer_sandboxes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE REFERENCES orgs (id),
  user_id TEXT NOT NULL UNIQUE REFERENCES users (id),
  created_at INTEGER NOT NULL,
  quickstart_viewed_at INTEGER,
  first_call_at INTEGER,
  first_pass_at INTEGER,
  first_preview_at INTEGER,
  first_live_key_at INTEGER,
  closed_at INTEGER,
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('idle', 'admin', 'user')),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE INDEX developer_sandboxes_open ON developer_sandboxes (created_at) WHERE closed_at IS NULL;

CREATE TRIGGER developer_sandboxes_fixed BEFORE UPDATE OF id, org_id, user_id, created_at ON developer_sandboxes
BEGIN SELECT RAISE(ABORT, 'a developer sandbox keeps its org and person'); END;
CREATE TRIGGER developer_sandboxes_funnel_set_once
BEFORE UPDATE OF quickstart_viewed_at, first_call_at, first_pass_at, first_preview_at, first_live_key_at, closed_at, close_reason
ON developer_sandboxes
WHEN (OLD.quickstart_viewed_at IS NOT NULL AND NEW.quickstart_viewed_at IS NOT OLD.quickstart_viewed_at)
  OR (OLD.first_call_at IS NOT NULL AND NEW.first_call_at IS NOT OLD.first_call_at)
  OR (OLD.first_pass_at IS NOT NULL AND NEW.first_pass_at IS NOT OLD.first_pass_at)
  OR (OLD.first_preview_at IS NOT NULL AND NEW.first_preview_at IS NOT OLD.first_preview_at)
  OR (OLD.first_live_key_at IS NOT NULL AND NEW.first_live_key_at IS NOT OLD.first_live_key_at)
  OR (OLD.closed_at IS NOT NULL AND (NEW.closed_at IS NOT OLD.closed_at OR NEW.close_reason IS NOT OLD.close_reason))
BEGIN SELECT RAISE(ABORT, 'a funnel column is set once'); END;
CREATE TRIGGER developer_sandboxes_no_delete BEFORE DELETE ON developer_sandboxes
BEGIN SELECT RAISE(ABORT, 'a developer sandbox is kept'); END;
CREATE TRIGGER developer_sandboxes_org_is_developer BEFORE INSERT ON developer_sandboxes
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer sandbox belongs to a developer org'); END;

-- The developer preset belongs to developer orgs, and they take no other.
INSERT INTO entitlement_preset_meta (preset, label, is_plan, revision, updated_at) VALUES
  ('developer', 'Developer sandbox', 0, 1, 1795046400000);

INSERT INTO entitlement_presets (preset, key, value) VALUES
  ('developer', 'api', '"full"'),
  ('developer', 'api.rateTier', '"standard"'),
  ('developer', 'api.keys', '3'),
  ('developer', 'apps', '0'),
  ('developer', 'webhooks', '1'),
  ('developer', 'webhooks.endpoints', '3'),
  ('developer', 'connections', '0'),
  ('developer', 'connectors', '[]'),
  ('developer', 'wallet.google', '0'),
  ('developer', 'wallet.samsung', '0'),
  ('developer', 'print', '0'),
  ('developer', 'nfc', '"off"'),
  ('developer', 'scanning.devices', '0'),
  ('developer', 'join.perDay', '0'),
  ('developer', 'messages.perDay', '0'),
  ('developer', 'passes.live', '0'),
  ('developer', 'passes.test', '500'),
  ('developer', 'templates', '10'),
  ('developer', 'templates.uploads', '0'),
  ('developer', 'templates.stylesBlocked', '[]'),
  ('developer', 'email.perDay', '100'),
  ('developer', 'members', '1'),
  ('developer', 'brand.mark', '"full"'),
  ('developer', 'domains', '0'),
  ('developer', 'identity.own', '0');

CREATE TRIGGER org_entitlements_developer_preset_insert BEFORE INSERT ON org_entitlements
WHEN (NEW.preset = 'developer') != COALESCE((SELECT o.kind = 'developer' FROM orgs o WHERE o.id = NEW.org_id), 0)
BEGIN SELECT RAISE(ABORT, 'the developer preset is for developer orgs only'); END;
CREATE TRIGGER org_entitlements_developer_preset_update BEFORE UPDATE OF preset ON org_entitlements
WHEN (NEW.preset = 'developer') != COALESCE((SELECT o.kind = 'developer' FROM orgs o WHERE o.id = NEW.org_id), 0)
BEGIN SELECT RAISE(ABORT, 'the developer preset is for developer orgs only'); END;
