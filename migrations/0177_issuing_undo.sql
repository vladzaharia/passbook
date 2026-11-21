-- Issuing at scale: undo for change runs and imports, held import email, richer connection runs.
ALTER TABLE broadcast_items ADD COLUMN before TEXT CHECK (before IS NULL OR json_valid(before));
ALTER TABLE broadcast_items ADD COLUMN version INTEGER;
ALTER TABLE pass_imports ADD COLUMN email_hold_until INTEGER;
ALTER TABLE pass_imports ADD COLUMN reverted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pass_import_rows ADD COLUMN undone_at INTEGER;
ALTER TABLE connection_runs ADD COLUMN passes_created INTEGER;
ALTER TABLE connection_runs ADD COLUMN passes_voided INTEGER;
ALTER TABLE connection_runs ADD COLUMN records_failed INTEGER;
-- Import undo: how long held mail waits, how many held mails an undo cancelled, the version an
-- update wrote (the undo's guard), and why an undo kept a pass.
ALTER TABLE pass_imports ADD COLUMN email_hold_ms INTEGER;
ALTER TABLE pass_imports ADD COLUMN undo_cancelled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pass_import_rows ADD COLUMN written_version INTEGER;
ALTER TABLE pass_import_rows ADD COLUMN undo_code TEXT;
