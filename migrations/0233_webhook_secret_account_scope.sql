-- A Shopify store signs every webhook of that store with one key, so a store's orders and customers
-- connections share a secret. The platform-wide unique fingerprint (0102) now leaves those recipes out;
-- the service refuses a Shopify secret held by another org or by a different recipe family.
DROP INDEX connections_webhook_secret_fp;
CREATE UNIQUE INDEX connections_webhook_secret_fp ON connections (webhook_secret_fp)
  WHERE webhook_secret_fp IS NOT NULL
    AND COALESCE(json_extract(config, '$.recipe'), '') NOT LIKE 'shopify-%';
DROP INDEX connections_webhook_prev_secret_fp;
CREATE UNIQUE INDEX connections_webhook_prev_secret_fp ON connections (webhook_prev_secret_fp)
  WHERE webhook_prev_secret_fp IS NOT NULL
    AND COALESCE(json_extract(config, '$.recipe'), '') NOT LIKE 'shopify-%';
