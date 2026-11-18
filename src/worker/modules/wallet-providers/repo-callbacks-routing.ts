// Kept import-free: both the callbacks and the sync targets route by it.
/**
 * Countries to notify for a ref: the market its ADDED reported, and only when it has none the
 * unsigned hints it received. Columns: ref_id, country_code.
 */
export const samsungRouteCountriesSql = `(
  SELECT market.id AS ref_id, market.market_cc2 AS country_code
    FROM wallet_samsung_fetch_refs market WHERE market.market_cc2 IS NOT NULL
  UNION ALL
  SELECT hint.ref_id, hint.country_code FROM wallet_samsung_country_hints hint
    JOIN wallet_samsung_fetch_refs hinted ON hinted.id = hint.ref_id WHERE hinted.market_cc2 IS NULL)`;
