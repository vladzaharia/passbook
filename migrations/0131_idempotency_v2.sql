-- Generic Idempotency-Key store. idempotency_keys (v1) stays until its callers move.
CREATE TABLE idempotent_requests (
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  principal TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  body TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, mode, principal, operation, key)
) WITHOUT ROWID;
CREATE INDEX idempotent_requests_expires ON idempotent_requests (expires_at);
