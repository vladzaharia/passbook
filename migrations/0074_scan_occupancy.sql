-- Occupancy on scan_presence: mode, due times, a commit-ordered sequence, ordered In now counts, tap-out
-- causes and one live override per scan.

-- The pass's mode, so In now counts without reading passes. The insert triggers take it from the pass.
ALTER TABLE scan_presence ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('live', 'test'));
UPDATE scan_presence SET mode = (SELECT p.mode FROM passes p WHERE p.id = scan_presence.pass_id);
-- When the system taps a pass out of a zone (max stay, the daily clear, a zone change). Null when out or no limit.
-- An in row past it reads as out to every scan before the cron closes it.
ALTER TABLE scan_presence ADD COLUMN due_at INTEGER;
-- Commit order of the pass's in/out writes: set inside the write, so an undo can tell what came after it.
ALTER TABLE scan_presence ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_presence ADD COLUMN prev_seq INTEGER;

-- The pass decides the mode: a writer that names another one is refused.
CREATE TRIGGER scan_presence_mode_check BEFORE INSERT ON scan_presence
WHEN NEW.mode IS NOT NULL AND NEW.mode IS NOT (SELECT p.mode FROM passes p WHERE p.id = NEW.pass_id)
BEGIN
  SELECT RAISE(ABORT, 'scan_presence mode differs from its pass');
END;
CREATE TRIGGER scan_presence_seq_insert AFTER INSERT ON scan_presence
BEGIN
  UPDATE scan_presence SET
    mode = (SELECT p.mode FROM passes p WHERE p.id = NEW.pass_id),
    seq = (SELECT COALESCE(MAX(x.seq), 0) + 1 FROM scan_presence x WHERE x.pass_id = NEW.pass_id)
  WHERE pass_id = NEW.pass_id AND scope = NEW.scope;
END;
-- A forward write moves last_scan_id and copies the old one to prev_scan_id; an undo's restore does not.
CREATE TRIGGER scan_presence_seq_update AFTER UPDATE OF last_scan_id ON scan_presence
WHEN NEW.last_scan_id IS NOT OLD.last_scan_id AND NEW.prev_scan_id IS OLD.last_scan_id
BEGIN
  UPDATE scan_presence SET
    prev_seq = OLD.seq,
    seq = (SELECT COALESCE(MAX(x.seq), 0) + 1 FROM scan_presence x WHERE x.pass_id = NEW.pass_id)
  WHERE pass_id = NEW.pass_id AND scope = NEW.scope;
END;

CREATE INDEX scan_presence_due ON scan_presence (due_at) WHERE due_at IS NOT NULL;
-- In now and capacity: equality on org, scope, state and mode, a range on due_at, without reading the rows.
-- It starts with scan_presence_org's columns, which it replaces.
CREATE INDEX scan_presence_inside ON scan_presence (org_id, scope, state, mode, due_at);
DROP INDEX scan_presence_org;
-- Who's inside, oldest entry first, paged.
CREATE INDEX scan_presence_list ON scan_presence (org_id, mode, scope, state, entered_at, pass_id);

-- Orders the In now counts monitors receive. One row per place ('zone:<id>' or 'event:<id>') and mode; only ever raised.
CREATE TABLE scan_place_revs (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  place TEXT NOT NULL,
  rev INTEGER NOT NULL CHECK (rev >= 1),
  PRIMARY KEY (org_id, mode, place)
) WITHOUT ROWID;

-- Why a tap-out wasn't the holder's: max stay, the daily clear, Mark as out, a forced re-entry, or a zone change.
ALTER TABLE scans ADD COLUMN out_cause TEXT CHECK (out_cause IS NULL OR out_cause IN ('stay', 'clear', 'desk', 'forced', 'zone'));
-- The desk's optional reason for an override.
ALTER TABLE scans ADD COLUMN override_note TEXT CHECK (override_note IS NULL OR override_note IN ('forgot_out', 'known', 'paid', 'other'));
-- One live override per scan: a scanner and a monitor letting the same person in race to one winner. A pending
-- claim holds it; an override that lost (heads-up or refused), failed or was undone frees it.
CREATE UNIQUE INDEX scans_override_once ON scans (override_of)
  WHERE override_of IS NOT NULL AND undone_at IS NULL AND state <> 'failed' AND (outcome IS NULL OR outcome = 'ok');
