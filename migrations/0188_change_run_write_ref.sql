-- A write by a run (change, action or undo) carries the run's id in `passes.write_ref`; no other write
-- touches the column. It is a carrier for the trigger below, and an undo's crash recovery reads it.
-- The trigger records, in the same statement as the write, the version it produced and the touched
-- inputs before and after, on the run's own target row. A settle after a crash then reads its own row:
-- another run's write, or any other write, to the same pass cannot hide it, and `before` is what the
-- write really replaced. `written_*` are never cleared: settle accepts them only above the intent's version.
ALTER TABLE passes ADD COLUMN write_ref TEXT;
ALTER TABLE broadcast_targets ADD COLUMN written_version INTEGER;
ALTER TABLE broadcast_targets ADD COLUMN written_prev TEXT;
ALTER TABLE broadcast_targets ADD COLUMN written_next TEXT;
CREATE TRIGGER change_run_write_landed
AFTER UPDATE OF write_ref ON passes
WHEN NEW.write_ref IS NOT NULL
BEGIN
  UPDATE broadcast_targets SET written_version = NEW.version,
    written_prev = (SELECT json_group_object(o.key, OLD.personalization -> o.fullkey)
      FROM json_each(OLD.personalization) o
      WHERE o.key IN (SELECT key FROM json_each(broadcast_targets.intent, '$.to'))),
    written_next = (SELECT json_group_object(o.key, NEW.personalization -> o.fullkey)
      FROM json_each(NEW.personalization) o
      WHERE o.key IN (SELECT key FROM json_each(broadcast_targets.intent, '$.to')))
    WHERE broadcast_id = NEW.write_ref AND pass_id = NEW.id AND intent IS NOT NULL;
END;
