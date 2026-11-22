-- The ledger of Google change messages (google-messages.md section 5, without the text: the history is read from
-- the object when it is trimmed). One row per (instance, base version, target version): a retry of an operation, or
-- a re-queue of the same pass version, finds its row and sends nothing again. `sending` is written immediately
-- before the POST, so a crash between the POST and the settle is seen next run and checked with a read.
CREATE TABLE wallet_google_messages (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  target_version INTEGER NOT NULL CHECK (target_version > base_version),
  notify INTEGER NOT NULL CHECK (notify IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('sending', 'notified', 'text', 'failed', 'unknown')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('budget', 'quota', 'refused', 'unconfirmed')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE (instance_id, base_version, target_version),
  CHECK ((state = 'sending') = (settled_at IS NULL))
);
CREATE UNIQUE INDEX wallet_google_messages_one_open ON wallet_google_messages (instance_id) WHERE state = 'sending';
CREATE INDEX wallet_google_messages_window ON wallet_google_messages (instance_id, settled_at);
CREATE TRIGGER wallet_google_messages_immutable
BEFORE UPDATE OF id, instance_id, base_version, target_version, notify, created_at ON wallet_google_messages
BEGIN SELECT RAISE(ABORT, 'google message identity is immutable'); END;
CREATE TRIGGER wallet_google_messages_settled_final
BEFORE UPDATE ON wallet_google_messages WHEN OLD.state != 'sending'
BEGIN SELECT RAISE(ABORT, 'a settled google message is final'); END;
