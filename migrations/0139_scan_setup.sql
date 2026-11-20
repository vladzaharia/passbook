-- Scan passes (one call per template) must not build twice. The session and each event it made carry
-- the key of what they were made for, and a unique index keeps one live holder of it: a second call
-- loses the insert and reads the winner. An ended session or an archived event gives its key back.
ALTER TABLE scanning_sessions ADD COLUMN setup_template_id TEXT;
CREATE UNIQUE INDEX scanning_sessions_setup ON scanning_sessions (org_id, mode, setup_template_id)
  WHERE setup_template_id IS NOT NULL AND status <> 'ended';
ALTER TABLE scan_events ADD COLUMN setup_key TEXT;
CREATE UNIQUE INDEX scan_events_setup ON scan_events (org_id, mode, setup_key)
  WHERE setup_key IS NOT NULL AND archived_at IS NULL;
