-- Connections: per-connection pacing overrides and the webhook record inbox.

ALTER TABLE connections ADD COLUMN max_concurrency INTEGER CHECK (max_concurrency IS NULL OR max_concurrency BETWEEN 1 AND 20);
ALTER TABLE connections ADD COLUMN requests_per_minute INTEGER CHECK (requests_per_minute IS NULL OR requests_per_minute BETWEEN 1 AND 6000);

-- Records delivered inside a signed webhook body. The queue message carries only refs; the job reads these.
CREATE TABLE connection_inbox (
  connection_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  record TEXT CHECK (record IS NULL OR json_valid(record)),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, event_id, ref),
  FOREIGN KEY (connection_id, event_id) REFERENCES webhook_events (connection_id, event_id) ON DELETE CASCADE
);
CREATE INDEX connection_inbox_received ON connection_inbox (received_at);
