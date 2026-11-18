// Kept import-free so account reads can share it without loading the callback fences.
/**
 * Before promotion, only a delivered wrapper in the current pass-authority epoch opens a window.
 * Binds `now` twice. Every use that must also hold after the verified ADDED promotes the ref
 * goes through this predicate, so the promoted and pre-promotion states share one proof.
 */
export const samsungInitialWindowSql = `(r.promoted_at IS NOT NULL OR
  (r.initial_expires_at > ? AND EXISTS (
    SELECT 1 FROM wallet_provider_offer_refs offer
    WHERE offer.instance_id = i.id AND offer.operation_version = op.version
      AND offer.consumed_at IS NOT NULL AND offer.delivered_at IS NOT NULL AND offer.expires_at > ?
      AND offer.pass_authority_generation = COALESCE(
        (SELECT generation FROM wallet_provider_pass_authority authority WHERE authority.pass_id = i.pass_id), 0))))`;
