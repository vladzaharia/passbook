-- Hard limit on zones and events: when on, Full is final for every role.
ALTER TABLE scan_zones ADD COLUMN hard_limit INTEGER NOT NULL DEFAULT 0 CHECK (hard_limit IN (0, 1));
ALTER TABLE scan_events ADD COLUMN hard_limit INTEGER NOT NULL DEFAULT 0 CHECK (hard_limit IN (0, 1));

-- An event's Hard limit is part of its configuration: an override that read it as off no longer commits.
DROP TRIGGER scan_events_config_epoch;
CREATE TRIGGER scan_events_config_epoch AFTER UPDATE OF match_input, match_values, opens_at, closes_at, time_zone, capacity, reentry, hard_limit, archived_at, org_id, mode ON scan_events
WHEN NEW.config_epoch = OLD.config_epoch AND (NEW.match_input IS NOT OLD.match_input OR NEW.match_values IS NOT OLD.match_values OR NEW.opens_at IS NOT OLD.opens_at OR NEW.closes_at IS NOT OLD.closes_at OR NEW.time_zone IS NOT OLD.time_zone OR NEW.capacity IS NOT OLD.capacity OR NEW.reentry IS NOT OLD.reentry OR NEW.hard_limit IS NOT OLD.hard_limit OR NEW.archived_at IS NOT OLD.archived_at OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode)
BEGIN UPDATE scan_events SET config_epoch = config_epoch + 1 WHERE rowid = NEW.rowid; END;
