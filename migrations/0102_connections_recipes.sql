-- Webhook recipes (PS-14): void rules, secret overlap, per-ref source order.
ALTER TABLE connections ADD COLUMN void_when TEXT
  CHECK (void_when IS NULL OR (json_valid(void_when) AND json_type(void_when) = 'array'
    AND json_array_length(void_when) <= 8));
ALTER TABLE connections ADD COLUMN webhook_prev_credential_id TEXT
  REFERENCES credentials (id) ON DELETE SET NULL;
-- A previous credential always has an expiry. The reverse is allowed: deleting the credential nulls only the id.
ALTER TABLE connections ADD COLUMN webhook_prev_until INTEGER
  CHECK (webhook_prev_credential_id IS NULL OR webhook_prev_until IS NOT NULL);
-- Keyed hash of a pasted recipe secret. Unique platform-wide: a Shopify store key signs every delivery of
-- that store, so two connections sharing one could replay each other's captured deliveries.
ALTER TABLE connections ADD COLUMN webhook_secret_fp TEXT;
CREATE UNIQUE INDEX connections_webhook_secret_fp ON connections (webhook_secret_fp)
  WHERE webhook_secret_fp IS NOT NULL;
-- The fingerprint of the previous secret, kept until the overlap ends so a demoted secret stays unique.
ALTER TABLE connections ADD COLUMN webhook_prev_secret_fp TEXT;
CREATE UNIQUE INDEX connections_webhook_prev_secret_fp ON connections (webhook_prev_secret_fp)
  WHERE webhook_prev_secret_fp IS NOT NULL;
CREATE INDEX connections_webhook_prev_credential ON connections (webhook_prev_credential_id)
  WHERE webhook_prev_credential_id IS NOT NULL;

CREATE TABLE connection_ref_versions (
  org_id TEXT NOT NULL REFERENCES orgs (id),
  connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
  ref TEXT NOT NULL CHECK (length(ref) <= 200),
  source_version INTEGER NOT NULL,
  -- Breaks a tie between records of the same version: the larger event id wins.
  source_event TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, ref)
);
CREATE INDEX connection_ref_versions_org ON connection_ref_versions (org_id);

-- void_when joins the generation bump set (it decides what a record does to a pass); the previous-secret
-- columns are volatile. Same trigger as 0044 plus void_when.
DROP TRIGGER connections_generation_bump;
CREATE TRIGGER connections_generation_bump AFTER UPDATE OF enabled, mode, org_id, connector_type, connector_version, config, credential_id, webhook_credential_id, mapping, default_template_id, holder_email_field, auto_create, auto_email, on_missing, void_when ON connections
WHEN NEW.generation = OLD.generation AND (
  NEW.enabled IS NOT OLD.enabled OR NEW.mode IS NOT OLD.mode OR NEW.org_id IS NOT OLD.org_id
  OR NEW.connector_type IS NOT OLD.connector_type OR NEW.connector_version IS NOT OLD.connector_version
  OR NEW.config IS NOT OLD.config OR NEW.credential_id IS NOT OLD.credential_id
  OR NEW.webhook_credential_id IS NOT OLD.webhook_credential_id OR NEW.mapping IS NOT OLD.mapping
  OR NEW.default_template_id IS NOT OLD.default_template_id
  OR NEW.holder_email_field IS NOT OLD.holder_email_field OR NEW.auto_create IS NOT OLD.auto_create
  OR NEW.auto_email IS NOT OLD.auto_email OR NEW.on_missing IS NOT OLD.on_missing
  OR NEW.void_when IS NOT OLD.void_when)
BEGIN UPDATE connections SET generation = generation + 1 WHERE id = NEW.id; END;
