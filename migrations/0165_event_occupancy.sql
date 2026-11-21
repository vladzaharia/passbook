-- Events never fall due: an event place has no auto tap-out (the event ends instead).
CREATE TRIGGER scan_presence_event_no_due_insert BEFORE INSERT ON scan_presence
WHEN NEW.scope GLOB 'event:*' AND NEW.due_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'event place has no due time'); END;

CREATE TRIGGER scan_presence_event_no_due_update BEFORE UPDATE OF due_at ON scan_presence
WHEN NEW.scope GLOB 'event:*' AND NEW.due_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'event place has no due time'); END;
