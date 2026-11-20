-- Offline reads are judged by the session as it was when the door took them (status, offline mode, hours,
-- hold, zone). The log now fills in the same statement as the edit, so a failure between the two cannot lose
-- a change, and an Open now or a Close now is recorded like any other edit. `timing` is NULL on rows written
-- before this migration: those reads fall back to the session's current hours.
ALTER TABLE scan_session_changes ADD COLUMN timing TEXT;
ALTER TABLE scan_session_changes ADD COLUMN prev_timing TEXT;

CREATE TRIGGER scanning_sessions_change_log
AFTER UPDATE OF status, settings, hours, hold, time_zone ON scanning_sessions
WHEN OLD.status IS NOT NEW.status OR OLD.hours IS NOT NEW.hours OR OLD.hold IS NOT NEW.hold
  OR OLD.time_zone IS NOT NEW.time_zone
  OR COALESCE(CASE WHEN json_valid(OLD.settings) THEN COALESCE(json_extract(OLD.settings, '$.whenOffline'),
       CASE WHEN json_extract(OLD.settings, '$.offline') THEN 'list' ELSE 'stop' END) END, 'stop')
     IS NOT COALESCE(CASE WHEN json_valid(NEW.settings) THEN COALESCE(json_extract(NEW.settings, '$.whenOffline'),
       CASE WHEN json_extract(NEW.settings, '$.offline') THEN 'list' ELSE 'stop' END) END, 'stop')
BEGIN
  INSERT OR IGNORE INTO scan_session_changes
    (session_id, org_id, at, status, mode, prev_status, prev_mode, timing, prev_timing)
  VALUES (
    NEW.id, NEW.org_id, NEW.updated_at, NEW.status,
    COALESCE(CASE WHEN json_valid(NEW.settings) THEN COALESCE(json_extract(NEW.settings, '$.whenOffline'),
      CASE WHEN json_extract(NEW.settings, '$.offline') THEN 'list' ELSE 'stop' END) END, 'stop'),
    OLD.status,
    COALESCE(CASE WHEN json_valid(OLD.settings) THEN COALESCE(json_extract(OLD.settings, '$.whenOffline'),
      CASE WHEN json_extract(OLD.settings, '$.offline') THEN 'list' ELSE 'stop' END) END, 'stop'),
    json_object('hours', NEW.hours, 'hold', NEW.hold, 'timeZone', NEW.time_zone),
    json_object('hours', OLD.hours, 'hold', OLD.hold, 'timeZone', OLD.time_zone)
  );
END;
