-- A chunk is staged before enqueue, so the queue and the seven-day inbox cleanup are not
-- the sole custodians of a verified webhook. Payloads are envelope-encrypted by the worker.
CREATE TABLE connection_webhook_retention (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  source TEXT NOT NULL CHECK (source IN ('ingress', 'legacy', 'legacy_duplicate_unproven', 'legacy_cleanup_unproven')),
  connection_mode TEXT NOT NULL CHECK (connection_mode IN ('webhook', 'hybrid', 'unknown')),
  reference_mode TEXT NOT NULL CHECK (reference_mode IN ('embedded-required', 'refs-only', 'unknown')),
  ref_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'failed', 'blocked', 'resolved', 'ignored')),
  error_code TEXT,
  release_snapshot TEXT NOT NULL CHECK (json_valid(release_snapshot)),
  snapshot_known INTEGER NOT NULL CHECK (snapshot_known IN (0, 1)),
  dispatch_complete INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_complete IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
  replay_generation INTEGER NOT NULL DEFAULT 0 CHECK (replay_generation >= 0),
  last_replay_id TEXT,
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (connection_id, event_id, ref_hash)
);
CREATE INDEX connection_webhook_retention_status
  ON connection_webhook_retention (connection_id, state, received_at DESC);
-- W1-12: retention expiry scans by state and age (daily cleanup, failed-payload TTL).
CREATE INDEX connection_webhook_retention_expiry
  ON connection_webhook_retention (state, updated_at);
-- W1-12: the cron sweep for ingress chunks whose dispatch never completed.
CREATE INDEX connection_webhook_retention_undispatched
  ON connection_webhook_retention (updated_at)
  WHERE source = 'ingress' AND state = 'pending' AND dispatch_complete = 0;
CREATE INDEX connection_webhook_retention_enqueue_failed
  ON connection_webhook_retention (updated_at)
  WHERE source = 'ingress' AND state = 'failed' AND error_code = 'WEBHOOK_ENQUEUE_FAILED';

-- Ordinals reveal no upstream identifiers. A started item is never assumed effect-free after a crash.
CREATE TABLE connection_webhook_items (
  retention_id TEXT NOT NULL REFERENCES connection_webhook_retention(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'started', 'success', 'blocked', 'failed', 'uncertain')),
  release_snapshot TEXT NOT NULL CHECK (json_valid(release_snapshot)),
  token TEXT,
  error_code TEXT,
  prior_unknown INTEGER NOT NULL CHECK (prior_unknown IN (0, 1)),
  PRIMARY KEY (retention_id, ordinal)
);

CREATE TABLE connection_webhook_legacy_sources (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX connection_webhook_legacy_sources_event
  ON connection_webhook_legacy_sources (connection_id, event_id);
-- W1-12: expiry deletes by received_at.
CREATE INDEX connection_webhook_legacy_sources_received
  ON connection_webhook_legacy_sources (received_at);

-- Replay decisions remain auditable after the encrypted payload expires.
CREATE TABLE connection_webhook_replays (
  id TEXT PRIMARY KEY,
  retention_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key')),
  actor_id TEXT NOT NULL,
  replay_generation INTEGER NOT NULL,
  old_release_id TEXT,
  old_release_generation INTEGER,
  old_release_version TEXT,
  old_block_code TEXT,
  new_release_id TEXT,
  new_release_generation INTEGER,
  new_release_version TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (retention_id, replay_generation)
);
