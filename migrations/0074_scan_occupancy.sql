-- Occupancy on scan_presence: due times, ordered In now counts, tap-out causes and one live override per scan.

-- When the system taps a pass out of a zone (max stay, the daily clear, a zone change). Null when out or no limit.
-- An in row past it reads as out to every scan before the cron closes it.
ALTER TABLE scan_presence ADD COLUMN due_at INTEGER;
CREATE INDEX scan_presence_due ON scan_presence (due_at) WHERE due_at IS NOT NULL;
-- In now: who is inside a place, without reading the rows.
CREATE INDEX scan_presence_inside ON scan_presence (org_id, scope, state, due_at, pass_id);

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
