-- Identity move (operation `identity.move`): the settings of one run, and one row per pass it replaces.
-- A row fixes the replacement's id when it is planned, so a rerun creates it at most once. The pass ids carry
-- no foreign key: a removed pass leaves its row for the audit trail, and the org purge clears both tables.
CREATE TABLE identity_moves (
  op_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  from_identity_id TEXT NOT NULL,
  to_identity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX identity_moves_org ON identity_moves (org_id);

CREATE TABLE pass_moves (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  from_identity_id TEXT NOT NULL,
  to_identity_id TEXT NOT NULL,
  old_pass_id TEXT NOT NULL UNIQUE,
  new_pass_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned', 'issued', 'notified', 'registered', 'voided', 'kept', 'failed')),
  -- A stable code: why the row is `kept` (connection, wallet_copy, user_tag, old_gone, old_revoked, new_gone, reminded) or `failed`.
  reason TEXT,
  -- What the replacement was built from, to tell later edits of the old pass from the move's own tell.
  copied_hash TEXT,
  -- The old pass's input and the replacement's, both as they stood at the copy (JSON): the two sides of the
  -- three-way diff that carries later edits.
  copied_input TEXT CHECK (copied_input IS NULL OR json_valid(copied_input)),
  made_input TEXT CHECK (made_input IS NULL OR json_valid(made_input)),
  -- Fields edited on both passes since the copy, with the side that won (JSON array).
  conflicts TEXT CHECK (conflicts IS NULL OR json_valid(conflicts)),
  told_at INTEGER,
  emailed_at INTEGER,
  remind_at INTEGER,
  reminded_at INTEGER,
  registered_at INTEGER,
  -- The device whose registration armed the void: it held the old pass, so it keeps counting after the old pass is deleted from it.
  armed_device TEXT,
  void_at INTEGER,
  -- Held while one sweep voids the old pass; a crashed sweep's claim lapses.
  claim_until INTEGER,
  voided_at INTEGER,
  -- Set in the batch that voids the old pass and re-points its per-pass state: from here the old pass is
  -- replaced by `replaced_by` (the replacement), API writes by the old id go there and syncs are refused.
  replaced_by TEXT,
  replaced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pass_moves_org ON pass_moves (org_id);
CREATE INDEX pass_moves_op ON pass_moves (op_id, state);
CREATE INDEX pass_moves_void_due ON pass_moves (void_at) WHERE state = 'registered';
CREATE INDEX pass_moves_remind_due ON pass_moves (remind_at) WHERE state IN ('issued', 'notified') AND reminded_at IS NULL;
CREATE INDEX pass_moves_open ON pass_moves (state) WHERE state IN ('issued', 'notified', 'kept');
CREATE INDEX pass_moves_replaced ON pass_moves (old_pass_id) WHERE replaced_by IS NOT NULL;

-- A printed card keeps working after a move: its print row follows the pass (the one change pass_prints_key allows,
-- only to the replacement of a move, in the tenant, while active). The printed code is derived from the pass id
-- the print was minted for, so `code_pass_id` keeps naming that pass for every later read of the code.
ALTER TABLE pass_prints ADD COLUMN code_pass_id TEXT;
DROP TRIGGER pass_prints_key;
CREATE TRIGGER pass_prints_key BEFORE UPDATE ON pass_prints
WHEN NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id
  OR NEW.mode IS NOT OLD.mode OR NEW.print_code_hash IS NOT OLD.print_code_hash
  OR NEW.roster_hash IS NOT OLD.roster_hash OR NEW.generation IS NOT OLD.generation
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.status != 'active' AND (NEW.status IS NOT OLD.status OR NEW.voided_at IS NOT OLD.voided_at
    OR NEW.void_cause IS NOT OLD.void_cause))
  OR (NEW.pass_id IS NOT OLD.pass_id AND NOT (OLD.status = 'active' AND NEW.status = 'active'
    AND NEW.code_pass_id IS COALESCE(OLD.code_pass_id, OLD.pass_id)
    AND EXISTS (SELECT 1 FROM pass_moves m JOIN passes n ON n.id = m.new_pass_id
      WHERE m.old_pass_id = OLD.pass_id AND m.new_pass_id = NEW.pass_id AND m.org_id = OLD.org_id
        AND n.org_id = OLD.org_id AND n.mode = OLD.mode)))
  OR (NEW.pass_id IS OLD.pass_id AND NEW.code_pass_id IS NOT OLD.code_pass_id)
BEGIN SELECT RAISE(ABORT, 'pass_print_key'); END;

-- The replacement of a move joins the webhook feed: the trigger of 0109 with one more kind.
DROP TRIGGER pass_events_feed;
CREATE TRIGGER pass_events_feed AFTER INSERT ON pass_events
WHEN NEW.kind IN ('pass.issued', 'pass.updated', 'pass.voided', 'pass.unvoided', 'pass.removed',
    'pass.restored', 'device.registered', 'device.unregistered', 'scan.checked_in', 'scan.redeemed',
    'scan.adjusted', 'scan.checked_out', 'scan.heads_up', 'scan.rejected', 'scan.undone',
    'push.failed', 'email.failed', 'pass.channels_changed', 'pass.printed', 'pass.print_voided', 'pass.replaced')
  AND NOT (NEW.kind = 'pass.updated' AND json_extract(NEW.data, '$.cause') IS 'resign')
  AND NOT EXISTS (SELECT 1 FROM settings WHERE scope = 'platform' AND key = 'events.feed' AND value = '"off"')
BEGIN
  INSERT OR IGNORE INTO event_feed (event_id, org_id, mode, pass_id, template_id, external_id, type,
    kind, device, device_count, actor_type, data, at)
  SELECT NEW.id, p.org_id, p.mode, p.id, p.template_id, p.external_id,
    CASE NEW.kind
      WHEN 'device.registered' THEN 'pass.installed'
      WHEN 'device.unregistered' THEN 'pass.uninstalled'
      WHEN 'scan.rejected' THEN 'pass.scan_refused'
      WHEN 'scan.undone' THEN 'pass.scan_undone'
      WHEN 'scan.checked_in' THEN 'pass.scanned' WHEN 'scan.redeemed' THEN 'pass.scanned'
      WHEN 'scan.adjusted' THEN 'pass.scanned' WHEN 'scan.checked_out' THEN 'pass.scanned'
      WHEN 'scan.heads_up' THEN 'pass.scanned'
      ELSE NEW.kind END,
    NEW.kind, NEW.device,
    CASE WHEN NEW.kind IN ('device.registered', 'device.unregistered')
      THEN (SELECT count(*) FROM registrations r WHERE r.pass_id = p.id
        AND r.credential_generation = p.credential_generation) END,
    NEW.actor_type, NEW.data, NEW.at
  FROM passes p JOIN orgs o ON o.id = p.org_id AND o.status = 'active'
  WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
    AND p.deleted_at IS NULL AND p.test_data_quarantined = 0;

  INSERT OR IGNORE INTO webhook_deliveries (endpoint_id, event_seq, org_id, mode)
  SELECT e.id, f.seq, f.org_id, f.mode
  FROM event_feed f
  JOIN webhook_endpoints e ON e.org_id = f.org_id AND e.mode = f.mode
  WHERE f.event_id = NEW.id
    AND e.status IN ('active', 'paused')
    AND EXISTS (SELECT 1 FROM json_each(e.event_types) t WHERE t.value = f.type)
    AND (e.template_ids IS NULL
      OR EXISTS (SELECT 1 FROM json_each(e.template_ids) t WHERE t.value = f.template_id));
END;
