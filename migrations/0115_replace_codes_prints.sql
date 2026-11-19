-- "Turn off and replace codes" issues a new scan code through the same mark as a manual New code (the old
-- code then reads "replaced"), but it must not end the pass's print: a paper ticket carries its own code
-- and has no digital copy to retire. The channel workflow, the bulk job and the pass override use system
-- actor ids with these prefixes; any other rotation still voids the active print.
DROP TRIGGER pass_prints_new_code;
CREATE TRIGGER pass_prints_new_code AFTER INSERT ON scan_code_rotations
WHEN NEW.actor_id IS NULL OR NOT (NEW.actor_id LIKE 'channel_apply:%'
  OR NEW.actor_id LIKE 'channel_bulk:%' OR NEW.actor_id LIKE 'channel_replace:%')
BEGIN
  UPDATE pass_prints SET status = 'voided', voided_at = NEW.rotated_at, void_cause = 'new_code'
  WHERE pass_id = NEW.pass_id AND status = 'active';
END;
