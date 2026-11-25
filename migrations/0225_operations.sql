-- One row per long-running action: the user-facing projection of its progress. It grants nothing.
-- `kind` is checked against the registry in code, so a new kind needs no table rebuild.
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('org', 'starter', 'platform')),
  org_id TEXT,
  mode TEXT CHECK (mode IS NULL OR mode IN ('live', 'test')),
  target_type TEXT,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  steps TEXT NOT NULL,
  step_key TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id TEXT,
  dedupe_key TEXT,
  retry_key TEXT,
  workflow_instance_id TEXT,
  lease_until INTEGER,
  heartbeat_at INTEGER,
  error_code TEXT,
  error_step TEXT,
  error_retryable INTEGER,
  result TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at INTEGER
);
CREATE UNIQUE INDEX operations_active_dedupe ON operations (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running', 'waiting');
CREATE INDEX operations_org ON operations (org_id, mode, created_at DESC) WHERE org_id IS NOT NULL;
CREATE INDEX operations_actor_open ON operations (actor_id, status, created_at DESC);
CREATE INDEX operations_target ON operations (target_type, target_id, created_at DESC);
CREATE INDEX operations_heartbeat ON operations (status, heartbeat_at) WHERE status = 'running';
CREATE INDEX operations_expiry ON operations (expires_at) WHERE expires_at IS NOT NULL;
