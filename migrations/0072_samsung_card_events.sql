-- Samsung Send Card State events (wallet-providers CW10a).
-- A verified ADDED promotes the ref once and records the market (cc2) that Update Notification needs.
-- Instances record when the holder saved or removed the card; installation_state stays 'unknown'.
-- Receipts keep the event and the delivery key (token hash + x-request-id) so redelivery is a no-op.
ALTER TABLE wallet_samsung_fetch_refs ADD COLUMN market_cc2 TEXT
  CHECK(market_cc2 IS NULL OR (length(market_cc2) = 2 AND market_cc2 NOT GLOB '*[^A-Z]*'));
ALTER TABLE wallet_provider_instances ADD COLUMN saved_at INTEGER;
ALTER TABLE wallet_provider_instances ADD COLUMN holder_removed_at INTEGER;
ALTER TABLE wallet_samsung_callback_receipts ADD COLUMN event TEXT
  CHECK(event IS NULL OR event IN ('ADDED', 'DELETED', 'UPDATED', 'PROVISIONED'));
ALTER TABLE wallet_samsung_callback_receipts ADD COLUMN cc2 TEXT
  CHECK(cc2 IS NULL OR (length(cc2) = 2 AND cc2 NOT GLOB '*[^A-Z]*'));
ALTER TABLE wallet_samsung_callback_receipts ADD COLUMN token_hash TEXT
  CHECK(token_hash IS NULL OR length(token_hash) = 43);
ALTER TABLE wallet_samsung_callback_receipts ADD COLUMN request_id TEXT
  CHECK(request_id IS NULL OR length(request_id) BETWEEN 1 AND 64);
CREATE UNIQUE INDEX wallet_samsung_callback_receipts_delivery
  ON wallet_samsung_callback_receipts(token_hash, request_id) WHERE token_hash IS NOT NULL;

-- Promotion is write-once, and the market it recorded is never rewritten.
CREATE TRIGGER wallet_samsung_ref_promotion_once BEFORE UPDATE OF promoted_at, market_cc2 ON wallet_samsung_fetch_refs
WHEN (OLD.promoted_at IS NOT NULL AND NEW.promoted_at IS NOT OLD.promoted_at)
  OR (OLD.market_cc2 IS NOT NULL AND NEW.market_cc2 IS NOT OLD.market_cc2)
BEGIN SELECT RAISE(ABORT, 'Samsung reference promotion is immutable'); END;
