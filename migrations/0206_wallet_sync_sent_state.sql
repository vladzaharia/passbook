-- The Samsung state a send target was told, written when the target is made, so a crash between the send and
-- the finish of a revoke recovers what was sent instead of reading the pass again (a restore may have landed).
ALTER TABLE wallet_provider_sync_targets ADD COLUMN sent_state TEXT
  CHECK (sent_state IS NULL OR sent_state IN ('ACTIVE', 'UPDATED', 'EXPIRED', 'CANCELED', 'DELETED'));
