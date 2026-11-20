-- Provider epochs (provider-epochs-design.md, PE3). Two trigger-owned counters that later packages compare
-- instead of re-proving a pile of columns. Nothing reads them yet, and the old fences are untouched.
--
-- wallet_provider_accounts.authority_epoch moves on a revoke and on a change of provider identity. A key
-- rotation under the same identity does not move it. wallet_provider_instances.instance_epoch moves on every
-- lifecycle, binding, desired-operation and retirement change. Both are written by their AFTER trigger only
-- and never go down. No existing trigger on either table watches these columns, and the inner UPDATE
-- names only the epoch, so no other trigger (transition, audit, dirty) fires for it.

-- The identity of a legacy credential: providerIdentityHash of what it holds (Google issuer; Samsung partner
-- and default card). NULL on rows from before this migration, which is the safe direction: a rotation
-- from or to a NULL identity moves the epoch. It joins the immutable columns of 0071.
ALTER TABLE wallet_provider_credentials ADD COLUMN identity_hash TEXT
  CHECK (identity_hash IS NULL OR (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'));

DROP TRIGGER wallet_provider_credentials_no_update;
CREATE TRIGGER wallet_provider_credentials_no_update BEFORE UPDATE ON wallet_provider_credentials
WHEN NOT (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek
  AND NEW.iv IS OLD.iv AND NEW.ciphertext IS OLD.ciphertext AND NEW.id IS OLD.id
  AND NEW.account_id IS OLD.account_id AND NEW.org_id IS OLD.org_id AND NEW.mode IS OLD.mode
  AND NEW.provider IS OLD.provider AND NEW.created_at IS OLD.created_at
  AND NEW.identity_hash IS OLD.identity_hash)
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider credential'); END;

-- Account epoch. Three things move it: revoked_at; identity_hash, which a new-model enrolment sets from its
-- source; and credential_id, which a legacy configure changes. A credential_id change moves it unless both
-- credentials carry the same identity. A NULL identity (or no old credential) matches nothing, so it moves.
ALTER TABLE wallet_provider_accounts ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(authority_epoch) = 'integer' AND authority_epoch >= 1);

CREATE TRIGGER wallet_provider_accounts_authority_epoch
AFTER UPDATE OF revoked_at, identity_hash, credential_id ON wallet_provider_accounts
WHEN NEW.authority_epoch = OLD.authority_epoch AND (
  NEW.revoked_at IS NOT OLD.revoked_at
  OR NEW.identity_hash IS NOT OLD.identity_hash
  OR (NEW.credential_id IS NOT OLD.credential_id AND NOT EXISTS (
    SELECT 1 FROM wallet_provider_credentials n JOIN wallet_provider_credentials o ON o.identity_hash = n.identity_hash
    WHERE n.id = NEW.credential_id AND o.id = OLD.credential_id)))
BEGIN
  UPDATE wallet_provider_accounts SET authority_epoch = authority_epoch + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER wallet_provider_accounts_authority_epoch_monotonic
BEFORE UPDATE OF authority_epoch ON wallet_provider_accounts
WHEN NEW.authority_epoch < OLD.authority_epoch
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;

-- Instance epoch. retirement_cause only ever changes together with retirement_requested_at; it is listed so
-- the bump set names every column that says why and how an instance is going away.
ALTER TABLE wallet_provider_instances ADD COLUMN instance_epoch INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(instance_epoch) = 'integer' AND instance_epoch >= 1);

CREATE TRIGGER wallet_provider_instances_epoch
AFTER UPDATE OF lifecycle, account_id, identity_projection_release_id, desired_version, desired_operation_id, retirement_requested_at, revoked_at, retired_at, retirement_reason, retirement_cause ON wallet_provider_instances
WHEN NEW.instance_epoch = OLD.instance_epoch AND (
  NEW.lifecycle IS NOT OLD.lifecycle
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.identity_projection_release_id IS NOT OLD.identity_projection_release_id
  OR NEW.desired_version IS NOT OLD.desired_version
  OR NEW.desired_operation_id IS NOT OLD.desired_operation_id
  OR NEW.retirement_requested_at IS NOT OLD.retirement_requested_at
  OR NEW.revoked_at IS NOT OLD.revoked_at
  OR NEW.retired_at IS NOT OLD.retired_at
  OR NEW.retirement_reason IS NOT OLD.retirement_reason
  OR NEW.retirement_cause IS NOT OLD.retirement_cause)
BEGIN
  UPDATE wallet_provider_instances SET instance_epoch = instance_epoch + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER wallet_provider_instances_epoch_monotonic
BEFORE UPDATE OF instance_epoch ON wallet_provider_instances
WHEN NEW.instance_epoch < OLD.instance_epoch
BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;

-- The fixed columns of an instance. 0037 and 0114 refused any SET of the first seven; this names every one
-- and adds created_at, so a SET to the same value is no longer refused. credential_keyset_commitment and
-- card_type have their own guards (0043, 0116).
DROP TRIGGER wallet_provider_instances_identity_immutable;
CREATE TRIGGER wallet_provider_instances_identity_immutable
BEFORE UPDATE OF id, pass_id, org_id, mode, provider, credential_generation, channel_epoch, created_at
  ON wallet_provider_instances
WHEN NEW.id IS NOT OLD.id OR NEW.pass_id IS NOT OLD.pass_id OR NEW.org_id IS NOT OLD.org_id
  OR NEW.mode IS NOT OLD.mode OR NEW.provider IS NOT OLD.provider
  OR NEW.credential_generation IS NOT OLD.credential_generation
  OR NEW.channel_epoch IS NOT OLD.channel_epoch OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'provider instance identity is immutable'); END;
