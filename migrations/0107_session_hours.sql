-- Session hours: a weekly schedule and a manual hold that gate an active scanning session.
-- hours and hold move the session's config epoch (an edit between the guard and the commit is stale);
-- hours_next_at is the cron's bookmark and moves nothing.
ALTER TABLE scanning_sessions ADD COLUMN hours TEXT CHECK(hours IS NULL OR json_valid(hours));
ALTER TABLE scanning_sessions ADD COLUMN hold TEXT CHECK(hold IS NULL OR json_valid(hold));
ALTER TABLE scanning_sessions ADD COLUMN hours_next_at INTEGER;
CREATE INDEX scanning_sessions_hours_due ON scanning_sessions(hours_next_at)
  WHERE status = 'active' AND hours_next_at IS NOT NULL;

DROP TRIGGER scanning_sessions_config_epoch;
CREATE TRIGGER scanning_sessions_config_epoch AFTER UPDATE OF status, accepts, settings, time_zone, org_id, mode, hours, hold ON scanning_sessions
WHEN NEW.config_epoch = OLD.config_epoch AND (NEW.status IS NOT OLD.status OR NEW.accepts IS NOT OLD.accepts OR NEW.settings IS NOT OLD.settings OR NEW.time_zone IS NOT OLD.time_zone OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode OR NEW.hours IS NOT OLD.hours OR NEW.hold IS NOT OLD.hold)
BEGIN UPDATE scanning_sessions SET config_epoch = config_epoch + 1 WHERE rowid = NEW.rowid; END;
