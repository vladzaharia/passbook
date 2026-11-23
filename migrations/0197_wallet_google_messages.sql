-- GM2: the Google change-message ledger (docs/design/wallet-providers/google-messages.md section 5).
-- One row per (instance, base version, target version): the message an upsert operation sends after it wrote
-- the object. The text is encrypted (platform/crypto envelope, AAD wallet-google-message-v1|instance|id) and
-- never logged. The row is scoped through its instance, like provider outcomes.
CREATE TABLE wallet_google_messages (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL REFERENCES wallet_provider_instance_operations(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  target_version INTEGER NOT NULL CHECK (target_version > base_version),
  notify INTEGER NOT NULL CHECK (notify IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'notified', 'text', 'failed', 'unknown', 'superseded')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('budget', 'quota', 'refused', 'unconfirmed', 'rate_limited', 'not_sent')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  tries INTEGER NOT NULL DEFAULT 0 CHECK (tries BETWEEN 0 AND 8),
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE (instance_id, base_version, target_version),
  CHECK ((state IN ('notified', 'text', 'failed', 'unknown')) = (settled_at IS NOT NULL))
);
CREATE UNIQUE INDEX wallet_google_messages_one_open ON wallet_google_messages (instance_id)
  WHERE state IN ('pending', 'sending');
CREATE INDEX wallet_google_messages_settled ON wallet_google_messages (instance_id, state, settled_at);
CREATE INDEX wallet_google_messages_purge ON wallet_google_messages (settled_at) WHERE settled_at IS NOT NULL;
CREATE INDEX wallet_google_messages_superseded ON wallet_google_messages (created_at) WHERE state = 'superseded';
CREATE INDEX wallet_google_messages_operation ON wallet_google_messages (operation_id);

CREATE TRIGGER wallet_google_messages_identity BEFORE UPDATE ON wallet_google_messages
WHEN NEW.id IS NOT OLD.id OR NEW.instance_id IS NOT OLD.instance_id
  OR NEW.base_version IS NOT OLD.base_version OR NEW.target_version IS NOT OLD.target_version
BEGIN SELECT RAISE(ABORT, 'google message identity is immutable'); END;

-- A settled message is final and a superseded one is dead; only a KEK re-wrap (kek_version, wrapped_dek) may touch it.
CREATE TRIGGER wallet_google_messages_settled_final BEFORE UPDATE ON wallet_google_messages
WHEN OLD.state IN ('notified', 'text', 'failed', 'unknown', 'superseded')
  AND (NEW.state IS NOT OLD.state OR NEW.reason IS NOT OLD.reason OR NEW.http_status IS NOT OLD.http_status
    OR NEW.tries IS NOT OLD.tries OR NEW.notify IS NOT OLD.notify OR NEW.settled_at IS NOT OLD.settled_at
    OR NEW.operation_id IS NOT OLD.operation_id OR NEW.created_at IS NOT OLD.created_at
    OR NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext)
BEGIN SELECT RAISE(ABORT, 'google message is settled'); END;
