-- A scanner bind keeps its idempotency key and request hash, so a retry replays the result (even after Undo).
-- A takeover of a lost tag keeps the lost report it cleared, so Undo can put it back.
ALTER TABLE tag_bindings ADD COLUMN idempotency_key TEXT;
ALTER TABLE tag_bindings ADD COLUMN request_hash TEXT;
ALTER TABLE tag_bindings ADD COLUMN cleared_lost_at INTEGER;
ALTER TABLE tag_bindings ADD COLUMN cleared_lost_by TEXT;
CREATE UNIQUE INDEX tag_bindings_idempotency ON tag_bindings (scanner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
