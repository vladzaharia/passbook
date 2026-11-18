-- Automatic messages: a stored filter plus a schedule. Every send is an ordinary broadcast
-- (broadcasts.rule_id); message_rule_fires makes each pass and occurrence fire once.

CREATE TABLE message_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('on', 'paused')),
  paused_code TEXT,
  template_ids TEXT NOT NULL CHECK (json_valid(template_ids) AND json_type(template_ids) = 'array'),
  match TEXT CHECK (match IS NULL OR json_valid(match)),
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('input', 'last_scan')),
  anchor_input TEXT CHECK ((anchor_kind = 'input') = (anchor_input IS NOT NULL)),
  offset_amount INTEGER NOT NULL CHECK (offset_amount BETWEEN 0 AND 366),
  offset_unit TEXT NOT NULL CHECK (offset_unit IN ('day', 'hour')),
  offset_when TEXT NOT NULL CHECK (offset_when IN ('before', 'after')),
  yearly INTEGER NOT NULL DEFAULT 0 CHECK (yearly IN (0, 1)),
  send_at TEXT NOT NULL DEFAULT '10:00',
  time_zone TEXT NOT NULL,
  message TEXT NOT NULL,
  clear_after INTEGER,
  next_check_at INTEGER,
  checked_at INTEGER,
  last_broadcast_id TEXT,
  sent INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by_type TEXT,
  created_by_id TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER NOT NULL
);
CREATE INDEX message_rules_org ON message_rules (org_id, mode, id DESC);
CREATE INDEX message_rules_due ON message_rules (next_check_at) WHERE state = 'on';

CREATE TABLE message_rule_fires (
  rule_id TEXT NOT NULL REFERENCES message_rules (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  occurrence TEXT NOT NULL,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  broadcast_id TEXT,
  fired_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, pass_id, occurrence)
) WITHOUT ROWID;
CREATE INDEX message_rule_fires_age ON message_rule_fires (fired_at);
CREATE INDEX message_rule_fires_pass ON message_rule_fires (pass_id);

-- A fire carries its rule's and its pass's org and mode.
CREATE TRIGGER message_rule_fires_tenant BEFORE INSERT ON message_rule_fires
WHEN NOT EXISTS (SELECT 1 FROM message_rules r WHERE r.id = NEW.rule_id AND r.org_id = NEW.org_id AND r.mode = NEW.mode)
  OR NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode)
BEGIN SELECT RAISE(ABORT, 'rule_fire_tenant'); END;

-- The rule that made a broadcast. Not a foreign key: a deleted rule's finished runs stay out of the manual list.
ALTER TABLE broadcasts ADD COLUMN rule_id TEXT;
ALTER TABLE broadcasts ADD COLUMN window_key TEXT;
CREATE UNIQUE INDEX broadcasts_rule_window ON broadcasts (rule_id, window_key) WHERE rule_id IS NOT NULL;
CREATE INDEX broadcasts_rule ON broadcasts (rule_id, id DESC) WHERE rule_id IS NOT NULL;
