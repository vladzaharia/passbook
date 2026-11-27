-- Last success and last failure per cron hook and queue job kind. Codes are stable, never messages.
CREATE TABLE hook_health (
  kind TEXT NOT NULL CHECK (kind IN ('cron', 'queue')),
  hook TEXT NOT NULL,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_failure_code TEXT,
  PRIMARY KEY (kind, hook)
) WITHOUT ROWID;

-- A queue message that reached the dead-letter queue and ended there: the terminal outcome of its job.
CREATE TABLE dlq_outcomes (
  message_id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL,
  org_id TEXT,
  target_id TEXT,
  code TEXT NOT NULL,
  dropped_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX dlq_outcomes_dropped ON dlq_outcomes (dropped_at);
