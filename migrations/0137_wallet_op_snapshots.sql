-- Provider epochs, PE4 (provider-epochs-design.md §2.2, §3). Operations, candidates and evidence also record the
-- pass row_version and the account authority_epoch they were made under. Nothing reads them yet: the old
-- revision fences stay the authority and PE5 switches to these columns.
-- Production operations, candidates and evidence are empty while providers are dark; the backfill covers
-- fixtures and placeholders only. A NULL pass_row_version means the op is never current again.

ALTER TABLE wallet_provider_instance_operations ADD COLUMN pass_row_version INTEGER
  CHECK (pass_row_version IS NULL OR (typeof(pass_row_version) = 'integer' AND pass_row_version > 0));
ALTER TABLE wallet_provider_instance_operations ADD COLUMN account_epoch INTEGER
  CHECK (account_epoch IS NULL OR (typeof(account_epoch) = 'integer' AND account_epoch > 0));
ALTER TABLE template_candidates ADD COLUMN provider_account_epoch INTEGER
  CHECK (provider_account_epoch IS NULL OR (typeof(provider_account_epoch) = 'integer' AND provider_account_epoch > 0));
ALTER TABLE wallet_provider_projection_evidence ADD COLUMN account_epoch INTEGER
  CHECK (account_epoch IS NULL OR (typeof(account_epoch) = 'integer' AND account_epoch > 0));
ALTER TABLE wallet_provider_projection_evidence_history ADD COLUMN account_epoch INTEGER
  CHECK (account_epoch IS NULL OR (typeof(account_epoch) = 'integer' AND account_epoch > 0));

UPDATE wallet_provider_instance_operations SET account_epoch = 1;
UPDATE wallet_provider_instance_operations AS op SET pass_row_version = (
  SELECT p.row_version FROM passes p JOIN wallet_provider_instances i ON i.pass_id = p.id
  WHERE i.id = op.instance_id AND p.version = op.pass_version AND p.revision = op.pass_revision);
UPDATE wallet_provider_projection_evidence SET account_epoch = 1;

-- The immutable tables are rewritten under their trigger, so it is dropped for the backfill and recreated.
DROP TRIGGER template_candidates_immutable;
UPDATE template_candidates SET provider_account_epoch = 1 WHERE provider_account_id IS NOT NULL;
CREATE TRIGGER template_candidates_immutable BEFORE UPDATE ON template_candidates
BEGIN SELECT RAISE(ABORT, 'template candidates are immutable'); END;

DROP TRIGGER wallet_provider_projection_evidence_history_no_update;
UPDATE wallet_provider_projection_evidence_history SET account_epoch = 1;
CREATE TRIGGER wallet_provider_projection_evidence_history_no_update BEFORE UPDATE ON wallet_provider_projection_evidence_history
BEGIN SELECT RAISE(ABORT, 'immutable Samsung provider evidence'); END;

DROP TRIGGER wallet_provider_instance_operation_snapshot_immutable;
CREATE TRIGGER wallet_provider_instance_operation_snapshot_immutable
BEFORE UPDATE OF instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
  lifecycle_generation, issuing_release_id, projection_release_id, account_revision,
  adapter_revision, policy_revision, pass_row_version, account_epoch ON wallet_provider_instance_operations
BEGIN SELECT RAISE(ABORT, 'provider operation snapshot is immutable'); END;
