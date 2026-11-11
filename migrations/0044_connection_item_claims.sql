-- The ingress/workflow key commitment is immutable once captured. NULL identifies
-- pre-cutover work and is never silently replaced by a later key.
ALTER TABLE connection_webhook_retention ADD COLUMN credential_keyset_commitment TEXT
  CHECK (credential_keyset_commitment IS NULL OR
    (length(credential_keyset_commitment) = 64 AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE workflow_runs ADD COLUMN credential_keyset_commitment TEXT
  CHECK (credential_keyset_commitment IS NULL OR
    (length(credential_keyset_commitment) = 64 AND credential_keyset_commitment NOT GLOB '*[^0-9a-f]*'));
CREATE TRIGGER connection_webhook_ingress_keyset_immutable
BEFORE UPDATE OF credential_keyset_commitment ON connection_webhook_retention
WHEN OLD.source = 'ingress' AND NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'ingress key commitment is immutable'); END;
CREATE TRIGGER connection_webhook_legacy_keyset_immutable
BEFORE UPDATE OF credential_keyset_commitment ON connection_webhook_retention
WHEN OLD.source <> 'ingress' AND OLD.credential_keyset_commitment IS NOT NULL
  AND NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'legacy key commitment is immutable'); END;
CREATE TRIGGER connection_workflow_keyset_immutable
BEFORE UPDATE OF credential_keyset_commitment ON workflow_runs
WHEN NEW.credential_keyset_commitment IS NOT OLD.credential_keyset_commitment
BEGIN SELECT RAISE(ABORT, 'workflow key commitment is immutable'); END;

-- A retained item owns its exact pass incarnation, or the ID reserved for its new pass,
-- before it may cause any effect. The reference itself remains in the encrypted payload;
-- claim_snapshot stores a digest together with the other non-secret admission values; an existing
-- pass is named by its row_version, not by its columns.
ALTER TABLE connection_webhook_items ADD COLUMN claim_kind TEXT
  CHECK (claim_kind IS NULL OR claim_kind IN ('existing', 'new'));
ALTER TABLE connection_webhook_items ADD COLUMN claim_pass_id TEXT;
ALTER TABLE connection_webhook_items ADD COLUMN claim_revision INTEGER;
ALTER TABLE connection_webhook_items ADD COLUMN claim_snapshot TEXT
  CHECK (claim_snapshot IS NULL OR json_valid(claim_snapshot));
ALTER TABLE connection_webhook_items ADD COLUMN claim_prior_unbound INTEGER NOT NULL DEFAULT 0
  CHECK (claim_prior_unbound IN (0, 1));

CREATE INDEX connection_webhook_items_claim_pass
  ON connection_webhook_items (claim_pass_id, state) WHERE claim_pass_id IS NOT NULL;
CREATE INDEX connection_webhook_items_claim_unbound
  ON connection_webhook_items (claim_prior_unbound, state, retention_id)
  WHERE claim_prior_unbound = 1;

-- START inserts its transfer reservation, then advances the pass generation through a
-- guarded CAS in the same D1 transaction. Either that reservation or a claim must win,
-- including when the transfer was requested by the item itself.
CREATE TRIGGER connection_webhook_claim_transfer_guard
BEFORE UPDATE OF credential_generation ON passes
WHEN NEW.credential_generation > OLD.credential_generation AND EXISTS (
  SELECT 1 FROM connection_webhook_items i
  JOIN connection_webhook_retention r ON r.id = i.retention_id
  WHERE i.state IN ('started', 'uncertain')
    AND (i.claim_pass_id = OLD.id OR (i.claim_prior_unbound = 1 AND r.org_id = OLD.org_id))
)
BEGIN SELECT RAISE(ABORT, 'unresolved retained webhook claim'); END;

-- Defend the transfer insertion boundary as well, including direct SQL callers.
CREATE TRIGGER connection_webhook_claim_transfer_insert_guard
BEFORE INSERT ON pass_credential_transfers
WHEN NEW.state = 'pending' AND EXISTS (
  SELECT 1 FROM connection_webhook_items i
  JOIN connection_webhook_retention r ON r.id = i.retention_id
  WHERE i.state IN ('started', 'uncertain')
    AND (i.claim_pass_id = NEW.pass_id OR (i.claim_prior_unbound = 1 AND r.org_id = NEW.org_id))
)
BEGIN SELECT RAISE(ABORT, 'unresolved retained webhook claim'); END;

-- A resolved/ignored parent must never cascade away an indeterminate effect. Manual
-- review first resolves the item; routine retention cleanup only removes settled work.
CREATE TRIGGER connection_webhook_unresolved_item_no_delete
BEFORE DELETE ON connection_webhook_items
WHEN OLD.state IN ('started', 'uncertain')
BEGIN SELECT RAISE(ABORT, 'unresolved retained webhook claim'); END;

-- connections.generation (the connection's authority epoch) is trigger-owned: the listed columns move it,
-- volatile columns (health, cursor, schedule, name, interval and limits) never do. docs/design/authority-epochs.md
-- section 1.1. The WHEN guard keeps an explicit generation write from bumping twice.
CREATE TRIGGER connections_generation_bump AFTER UPDATE OF enabled, mode, org_id, connector_type, connector_version, config, credential_id, webhook_credential_id, mapping, default_template_id, holder_email_field, auto_create, auto_email, on_missing ON connections
WHEN NEW.generation = OLD.generation AND (
  NEW.enabled IS NOT OLD.enabled OR NEW.mode IS NOT OLD.mode OR NEW.org_id IS NOT OLD.org_id
  OR NEW.connector_type IS NOT OLD.connector_type OR NEW.connector_version IS NOT OLD.connector_version
  OR NEW.config IS NOT OLD.config OR NEW.credential_id IS NOT OLD.credential_id
  OR NEW.webhook_credential_id IS NOT OLD.webhook_credential_id OR NEW.mapping IS NOT OLD.mapping
  OR NEW.default_template_id IS NOT OLD.default_template_id
  OR NEW.holder_email_field IS NOT OLD.holder_email_field OR NEW.auto_create IS NOT OLD.auto_create
  OR NEW.auto_email IS NOT OLD.auto_email OR NEW.on_missing IS NOT OLD.on_missing)
BEGIN UPDATE connections SET generation = generation + 1 WHERE id = NEW.id; END;
