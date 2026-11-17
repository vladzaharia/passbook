-- The scanning session a scan was claimed in; a passless replay must come from the same one.
ALTER TABLE scans ADD COLUMN session_id TEXT;
