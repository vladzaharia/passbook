// Kept import-free: both the callbacks and the sync targets route by it.
/**
 * Countries to notify for a ref: the market its ADDED reported. A ref with none uses the unsigned
 * hints it received; one that served card data and was never confirmed (no promotion) is also
 * sent to the market its approved projection is enabled for. Columns: ref_id, country_code.
 */
export const samsungRouteCountriesSql = `(
  SELECT market.id AS ref_id, market.market_cc2 AS country_code
    FROM wallet_samsung_fetch_refs market WHERE market.market_cc2 IS NOT NULL
  UNION ALL
  SELECT hint.ref_id, hint.country_code FROM wallet_samsung_country_hints hint
    JOIN wallet_samsung_fetch_refs hinted ON hinted.id = hint.ref_id WHERE hinted.market_cc2 IS NULL
  UNION ALL
  SELECT unconfirmed.id AS ref_id, json_extract(candidate.projection_json, '$.countryCode') AS country_code
    FROM wallet_samsung_fetch_refs unconfirmed
    JOIN wallet_provider_instances unconfirmed_instance ON unconfirmed_instance.id = unconfirmed.instance_id
    JOIN wallet_provider_instance_operations unconfirmed_op
      ON unconfirmed_op.id = unconfirmed_instance.desired_operation_id
    JOIN template_releases unconfirmed_release ON unconfirmed_release.id = unconfirmed_op.projection_release_id
    JOIN template_candidates candidate ON candidate.id = unconfirmed_release.candidate_id
    WHERE unconfirmed.market_cc2 IS NULL AND unconfirmed.promoted_at IS NULL
      AND unconfirmed.served_at IS NOT NULL
      AND json_extract(candidate.projection_json, '$.countryCode') IS NOT NULL)`;

/**
 * A ref a revoke may notify: promoted, or served and never confirmed since before the cutoff
 * (now minus SAMSUNG_UNCONFIRMED_SERVE_MS, bound once). `ref` and `op` are the aliases in scope.
 */
export const samsungRevocableRefSql = (ref: string, op: string) =>
  `(${ref}.promoted_at IS NOT NULL OR (${op}.kind = 'revoke' AND ${ref}.served_at IS NOT NULL
    AND ${ref}.served_at <= ?))`;
