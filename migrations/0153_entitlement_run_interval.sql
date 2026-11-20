-- An entitlement run (0151) covers an interval of the org's entitlement revisions: the channels the plan
-- blocked before it (`from_blocked`, at revision `from_rev` - 1) and after it (`to_blocked`, at `to_rev`).
-- Two jobs of one revision, or a retry, find the revision covered and open nothing: the journal and the
-- pass.channels_changed webhooks go out once. All four are NULL on a template-save run.
ALTER TABLE channel_apply_runs ADD COLUMN to_blocked TEXT CHECK (to_blocked IS NULL OR json_valid(to_blocked));
ALTER TABLE channel_apply_runs ADD COLUMN from_rev INTEGER;
ALTER TABLE channel_apply_runs ADD COLUMN to_rev INTEGER;
-- The plan state is writable while the run waits (a job extends or adopts it) and frozen once it starts.
CREATE TRIGGER channel_apply_runs_plan BEFORE UPDATE ON channel_apply_runs
WHEN OLD.state != 'pending' AND (NEW.from_blocked IS NOT OLD.from_blocked OR NEW.to_blocked IS NOT OLD.to_blocked
  OR NEW.from_rev IS NOT OLD.from_rev OR NEW.to_rev IS NOT OLD.to_rev)
BEGIN SELECT RAISE(ABORT, 'channel apply run plan state is frozen once started'); END;
