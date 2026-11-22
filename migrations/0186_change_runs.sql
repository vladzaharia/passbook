-- Change runs: a stop asked for while a run sends (the run ends itself after its chunk), the run's own
-- workflow instance (an undo that died restarts under a new one), and the plan's daily cap, seeded like
-- `messages.perDay` and held equal by the entitlements registry.
ALTER TABLE broadcasts ADD COLUMN stop_at INTEGER;
ALTER TABLE broadcasts ADD COLUMN instance TEXT;
INSERT OR IGNORE INTO entitlement_presets (preset, key, value)
  SELECT preset, 'passes.changesPerDay', value FROM entitlement_presets WHERE key = 'messages.perDay';
-- The passes a change run acts on, one row each: chosen at create, or snapshotted from a filter or an
-- import when the run starts. `intent` is written before a pass is changed and cleared in the batch that
-- records its item, so a step that died between the two is settled, never applied twice.
CREATE TABLE broadcast_targets (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  intent TEXT CHECK (intent IS NULL OR json_valid(intent)),
  PRIMARY KEY (broadcast_id, pass_id)
) WITHOUT ROWID;
CREATE INDEX broadcast_targets_intent ON broadcast_targets (broadcast_id, pass_id) WHERE intent IS NOT NULL;
CREATE INDEX IF NOT EXISTS broadcast_targets_pass_fk ON broadcast_targets (pass_id);
-- An org's own broadcast cap carries over to change runs.
INSERT OR IGNORE INTO org_entitlement_overrides (org_id, key, value, note, expires_at, updated_at, updated_by)
  SELECT org_id, 'passes.changesPerDay', value, note, expires_at, updated_at, updated_by
  FROM org_entitlement_overrides WHERE key = 'messages.perDay';
-- One resume per change run (a second retry of the same run is refused by this index), and the mark that a
-- run's snapshot of target rows reached its last page (a start that died halfway continues it).
ALTER TABLE broadcasts ADD COLUMN retry_of TEXT;
CREATE UNIQUE INDEX broadcasts_retry_of ON broadcasts (retry_of) WHERE retry_of IS NOT NULL;
ALTER TABLE broadcasts ADD COLUMN snapshot_at INTEGER;
