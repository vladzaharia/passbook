-- Every inbound webhook delivery attempt on an enabled webhook connection of an active org, and why it
-- was accepted, ignored or refused. The ingress URL is public, so the row holds only closed values
-- (outcome, reason, content class), a topic from the recipe's own list, and the signed event id of an
-- accepted event: never a body, a header value, an address or any sender text.
-- Rejects, duplicates and ignores coalesce per minute through coalesce_key (count, last_at). The worker
-- keeps at most 50 rows per connection (20 of them rejects) and the daily connections hook drops rows
-- older than 7 days, except the earliest verified one, which carries first_verified_arrival_at.
CREATE TABLE connection_webhook_arrivals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  received_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'duplicate', 'ignored', 'rejected')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'signature_missing', 'signature_mismatch', 'signature_expired', 'payload', 'too_large', 'no_secret',
    'unknown_type', 'thin_event', 'test_mode', 'unrecognized_shape', 'no_ref', 'ping', 'stale'
  )),
  topic TEXT CHECK (topic IS NULL OR length(topic) <= 100),
  content_class TEXT NOT NULL CHECK (content_class IN ('json', 'xml', 'form', 'other')),
  event_ref TEXT CHECK (event_ref IS NULL OR length(event_ref) <= 200),
  retention_id TEXT,
  used_previous INTEGER NOT NULL DEFAULT 0 CHECK (used_previous IN (0, 1)),
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  -- Null for an accepted event (one row each); else outcome, reason, topic and the minute.
  coalesce_key TEXT,
  UNIQUE (connection_id, coalesce_key)
);
CREATE INDEX connection_webhook_arrivals_recent
  ON connection_webhook_arrivals (connection_id, last_at DESC);
CREATE INDEX connection_webhook_arrivals_expiry
  ON connection_webhook_arrivals (last_at);

-- A connection that already received verified events is not "waiting for its first event".
INSERT INTO connection_webhook_arrivals
  (id, org_id, connection_id, received_at, last_at, outcome, content_class, count)
SELECT lower(hex(randomblob(16))), r.org_id, r.connection_id, MIN(r.received_at), MIN(r.received_at),
  'accepted', 'other', 1
FROM connection_webhook_retention r
WHERE r.source = 'ingress' AND r.connection_id IN (SELECT id FROM connections)
GROUP BY r.org_id, r.connection_id;
