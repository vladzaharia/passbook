-- A change run's write to a pass carries the run's id in `passes.write_ref`. The trigger below records,
-- in the same statement, the version that write produced on the run's own target row, so a settle after a
-- crash reads its own run's row: another run, or any other write, to the same pass cannot hide it.
-- Writes that are not a run's leave `write_ref` alone and never fire the trigger.
ALTER TABLE passes ADD COLUMN write_ref TEXT;
ALTER TABLE broadcast_targets ADD COLUMN written_version INTEGER;
CREATE TRIGGER change_run_write_landed
AFTER UPDATE OF write_ref ON passes
WHEN NEW.write_ref IS NOT NULL
BEGIN
  UPDATE broadcast_targets SET written_version = NEW.version
    WHERE broadcast_id = NEW.write_ref AND pass_id = NEW.id AND intent IS NOT NULL;
END;
