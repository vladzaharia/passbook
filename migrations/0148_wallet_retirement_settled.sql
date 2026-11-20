-- Retirement settled column (provider-epochs-design.md D5, PE5d). "Settled" was copied into five triggers and
-- three JS predicates. It is now computed once, by the wallet_provider_retirement_complete view, when an
-- instance becomes retired, and stored. Every reader checks retirement_settled_at IS NOT NULL.
-- Settledness is monotone: every input is retained, immutable or insert-once. The column is written only by
-- the settle trigger and is write-once.
ALTER TABLE wallet_provider_instances ADD COLUMN retirement_settled_at INTEGER;
CREATE INDEX wallet_provider_instances_unsettled ON wallet_provider_instances(pass_id, credential_generation)
  WHERE retirement_settled_at IS NULL;

-- Backfill before the guard exists and before the readers switch. Same migration, so a delete or purge of
-- an already settled placeholder keeps working.
UPDATE wallet_provider_instances SET retirement_settled_at = COALESCE(retired_at, updated_at)
  WHERE id IN (SELECT id FROM wallet_provider_retirement_complete);

-- Fires on every path that retires: retireUnissuedPlaceholder, retireInstance and the generation_advance
-- placeholder sweep (0043) all UPDATE lifecycle.
CREATE TRIGGER wallet_provider_instances_settle AFTER UPDATE OF lifecycle ON wallet_provider_instances
WHEN NEW.lifecycle = 'retired' AND NEW.retirement_settled_at IS NULL
  AND EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = NEW.id)
BEGIN
  UPDATE wallet_provider_instances SET retirement_settled_at = COALESCE(NEW.retired_at, NEW.updated_at)
    WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER wallet_provider_instances_settled_guard BEFORE UPDATE OF retirement_settled_at ON wallet_provider_instances
WHEN OLD.retirement_settled_at IS NOT NULL OR NEW.retirement_settled_at IS NULL OR NEW.lifecycle != 'retired'
  OR NOT EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'provider retirement is not settled'); END;
CREATE TRIGGER wallet_provider_instances_settled_insert_guard BEFORE INSERT ON wallet_provider_instances
WHEN NEW.retirement_settled_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'provider retirement is not settled'); END;

-- The evidence can also complete after the instance retired: the last busy operation finishing, or the last
-- tombstone landing. These settle it the same way. The guard re-proves the view each time.
CREATE TRIGGER wallet_provider_operations_settle AFTER UPDATE OF state ON wallet_provider_instance_operations
WHEN OLD.state IN ('pending', 'retry', 'claimed', 'uncertain')
  AND NEW.state NOT IN ('pending', 'retry', 'claimed', 'uncertain')
BEGIN
  UPDATE wallet_provider_instances SET retirement_settled_at = COALESCE(retired_at, updated_at)
    WHERE id = NEW.instance_id AND lifecycle = 'retired' AND retirement_settled_at IS NULL
      AND EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = wallet_provider_instances.id);
END;
CREATE TRIGGER wallet_provider_tombstones_settle AFTER INSERT ON wallet_samsung_tombstones
BEGIN
  UPDATE wallet_provider_instances SET retirement_settled_at = COALESCE(retired_at, updated_at)
    WHERE id IN (SELECT ref.instance_id FROM wallet_samsung_fetch_refs ref WHERE ref.ref_hash = NEW.ref_hash)
      AND lifecycle = 'retired' AND retirement_settled_at IS NULL
      AND EXISTS (SELECT 1 FROM wallet_provider_retirement_complete done WHERE done.id = wallet_provider_instances.id);
END;

-- PE3 review L1: INSERT OR REPLACE on an account skips the no_delete trigger (recursive_triggers is off),
-- so it would reset authority_epoch and bring revoked_at back. Refuse a same-id insert, as 0043 does for
-- instances. ON CONFLICT(org_id, mode, provider) DO NOTHING inserts a fresh id and is unaffected. A REPLACE
-- under a new id for the same org, mode and provider is not caught here: PE6 puts the table behind grants.
CREATE TRIGGER wallet_provider_accounts_no_replace BEFORE INSERT ON wallet_provider_accounts
WHEN EXISTS (SELECT 1 FROM wallet_provider_accounts existing WHERE existing.id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'provider account identity is immutable'); END;

-- Readers. Each keeps the org and mode equalities it had.
DROP TRIGGER wallet_provider_instance_delete_settled;
CREATE TRIGGER wallet_provider_instance_delete_settled BEFORE DELETE ON wallet_provider_instances
WHEN OLD.retirement_settled_at IS NULL
  OR EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id
    AND (p.org_id != OLD.org_id OR p.mode != OLD.mode))
BEGIN SELECT RAISE(ABORT, 'provider retirement incomplete'); END;

DROP TRIGGER wallet_provider_pass_delete_settled;
CREATE TRIGGER wallet_provider_pass_delete_settled BEFORE DELETE ON passes
WHEN EXISTS (SELECT 1 FROM wallet_provider_instances i WHERE i.pass_id = OLD.id
  AND (i.org_id != OLD.org_id OR i.mode != OLD.mode OR i.retirement_settled_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'provider retirement incomplete'); END;

DROP TRIGGER wallet_provider_transfer_complete_guard;
CREATE TRIGGER wallet_provider_transfer_complete_guard BEFORE UPDATE OF state ON pass_credential_transfers
WHEN OLD.state = 'pending' AND NEW.state = 'completed' AND (
  NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id AND p.mode = OLD.mode
    AND p.credential_generation = OLD.target_generation)
  OR (SELECT COUNT(*) FROM wallet_provider_instances i
    JOIN wallet_provider_unissued_placeholder empty ON empty.id = i.id
    JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = i.credential_keyset_commitment
    WHERE i.pass_id = OLD.pass_id AND i.org_id = OLD.org_id AND i.mode = OLD.mode
      AND i.credential_generation = OLD.target_generation AND i.lifecycle = 'blocked'
      AND i.retirement_requested_at IS NULL AND i.provider IN ('google', 'samsung')) != 2
  OR EXISTS (SELECT 1 FROM wallet_provider_instances previous WHERE previous.pass_id = OLD.pass_id
    AND previous.credential_generation < OLD.target_generation
    AND (previous.org_id != OLD.org_id OR previous.mode != OLD.mode OR previous.retirement_settled_at IS NULL))
)
BEGIN SELECT RAISE(ABORT, 'provider retirement incomplete'); END;

DROP TRIGGER wallet_provider_generation_ready_guard;
CREATE TRIGGER wallet_provider_generation_ready_guard BEFORE UPDATE OF lifecycle ON wallet_provider_instances
WHEN OLD.lifecycle = 'blocked' AND NEW.lifecycle = 'ready'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM passes p JOIN pass_credential_transfers t ON t.pass_id = p.id
    JOIN wallet_provider_unissued_placeholder empty ON empty.id = OLD.id
    JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = OLD.credential_keyset_commitment
    WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id AND p.mode = OLD.mode
      AND p.credential_generation = OLD.credential_generation AND OLD.retirement_requested_at IS NULL
      AND t.org_id = p.org_id AND t.mode = p.mode AND t.target_generation = OLD.credential_generation
      AND t.state = 'completed'
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers pending
        WHERE pending.pass_id = p.id AND pending.state = 'pending')
  ) THEN RAISE(ABORT, 'provider generation is blocked') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM passes p JOIN wallet_provider_instances previous ON previous.pass_id = p.id
    WHERE p.id = OLD.pass_id AND previous.credential_generation < OLD.credential_generation
      AND (previous.org_id != p.org_id OR previous.mode != p.mode
        OR previous.retirement_settled_at IS NULL)
  ) THEN RAISE(ABORT, 'provider generation is blocked') END;
END;

-- The finish: a prior incarnation must be settled (the view adds the keyset and Samsung reason terms the
-- 0055 inline copy lacked; wallet_provider_transfer_complete_guard already required them).
DROP TRIGGER pass_credential_transfer_complete_guard;
CREATE TRIGGER pass_credential_transfer_complete_guard
BEFORE UPDATE ON pass_credential_transfers
WHEN OLD.state != 'pending' OR NEW.state != 'completed'
  OR OLD.id IS NOT NEW.id OR OLD.pass_id IS NOT NEW.pass_id OR OLD.org_id IS NOT NEW.org_id
  OR OLD.mode IS NOT NEW.mode OR OLD.source_generation IS NOT NEW.source_generation
  OR OLD.source_version IS NOT NEW.source_version OR OLD.source_revision IS NOT NEW.source_revision
  OR OLD.source_row_version IS NOT NEW.source_row_version
  OR OLD.source_lifecycle_generation IS NOT NEW.source_lifecycle_generation
  OR OLD.source_link_generation IS NOT NEW.source_link_generation
  OR OLD.source_connection_id IS NOT NEW.source_connection_id
  OR OLD.source_connection_ref IS NOT NEW.source_connection_ref
  OR OLD.source_connection_generation IS NOT NEW.source_connection_generation
  OR OLD.source_connection_mode IS NOT NEW.source_connection_mode
  OR OLD.source_admitted_release_id IS NOT NEW.source_admitted_release_id
  OR OLD.source_admitted_release_generation IS NOT NEW.source_admitted_release_generation
  OR OLD.source_admitted_release_version IS NOT NEW.source_admitted_release_version
  OR OLD.target_holder_email IS NOT NEW.target_holder_email
  OR OLD.target_owner_user_id IS NOT NEW.target_owner_user_id
  OR OLD.requested_by_type IS NOT NEW.requested_by_type OR OLD.requested_by_id IS NOT NEW.requested_by_id
  OR OLD.requested_at IS NOT NEW.requested_at
  OR NEW.completed_at IS NULL
  OR NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id
    AND p.mode = OLD.mode AND p.credential_generation = OLD.target_generation
    AND p.row_version > OLD.source_row_version
    AND p.lifecycle_generation = OLD.source_lifecycle_generation
    AND p.link_generation = OLD.source_link_generation
    AND p.holder_email IS OLD.target_holder_email AND p.owner_user_id IS OLD.target_owner_user_id)
  -- A connector transfer finishes against whatever the connection and release head are now: a connection
  -- edit or a newer approved release moves neither the binding nor the head the finish rebuilt against.
  OR (OLD.source_connection_id IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM pass_credential_transfer_payloads payload WHERE payload.transfer_id = OLD.id)
    OR NOT EXISTS (
      SELECT 1 FROM passes p
      JOIN templates template ON template.id = p.template_id
      JOIN template_releases rel ON rel.id = p.release_id
      WHERE p.id = OLD.pass_id AND p.org_id = OLD.org_id AND p.mode = 'live'
        AND p.connection_id = OLD.source_connection_id AND p.external_ref IS OLD.source_connection_ref
        AND p.template_version = rel.version
        AND rel.template_id = p.template_id AND rel.mode = p.mode AND rel.provider = 'apple'
        AND (rel.org_id = p.org_id OR (rel.org_id IS NULL
          AND template.org_id IS NULL AND template.origin = 'baked'))
        AND ((template.status = 'active'
            AND EXISTS (SELECT 1 FROM template_release_heads head WHERE head.release_id = rel.id))
          OR (template.status != 'deleted' AND rel.id = OLD.source_admitted_release_id))
    )
  ))
  OR EXISTS (
    SELECT 1 FROM wallet_provider_instances i
    WHERE i.pass_id = OLD.pass_id AND i.credential_generation < OLD.target_generation
      AND (i.org_id IS NOT OLD.org_id OR i.mode IS NOT OLD.mode OR i.retirement_settled_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'credential transfer is not ready to complete'); END;

-- WA6a review: 0141 exempted a human version author for any system candidate. Scope it to Google. Samsung
-- retirement and tombstone proofs (0043, 0050, repo-instance-retirement-sql.ts, repo-callbacks-tombstone-
-- retirement.ts) keep the raw version-author predicate, so a Samsung exemption would release a candidate
-- those proofs then refuse. These are 0141's triggers unchanged otherwise; BEFORE triggers fire newest
-- first, so the keyset checks are recreated after the ones they must follow.
-- PE5e: the approval and release triggers compare the account epoch the candidate captured, so a key
-- rotation under the same identity keeps approvals and an identity change or revoke voids them.
DROP TRIGGER template_provider_approvals_insert;
CREATE TRIGGER template_provider_approvals_insert BEFORE INSERT ON template_approvals
WHEN EXISTS (SELECT 1 FROM template_candidates c WHERE c.id = NEW.candidate_id
  AND c.provider IN ('google', 'samsung')) AND NOT EXISTS (
  SELECT 1 FROM template_candidates c JOIN template_provider_apple_sources s ON s.id = c.source_release_id
  JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.version
  JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
    AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = c.provider
    AND account.authority_epoch = c.provider_account_epoch
    AND account.credential_id IS NOT NULL
    AND account.revoked_at IS NULL
  WHERE c.id = NEW.candidate_id AND NEW.candidate_hash = c.candidate_hash
    AND NEW.reviewer_id != c.author_id
    AND (c.version_author_id IS NULL OR (c.author_id = 'system:wallet-projection' AND c.provider = 'google') OR NEW.reviewer_id != c.version_author_id)
    AND (NEW.reviewer_id != 'system:wallet-projection:auto' OR (c.author_id = 'system:wallet-projection' AND c.provider = 'google'
      AND json_array_length(json_extract(c.projection_json, '$.approvedOmissions')) = 0))
    AND v.created_by IS c.version_author_id AND s.template_id = c.template_id AND s.mode = c.mode
    AND s.version = c.version AND (s.org_id = c.org_id OR (s.org_id IS NULL AND s.origin = 'baked' AND s.template_org_id IS NULL))
    AND s.generation = c.source_release_generation AND s.candidate_hash = c.source_release_hash
    AND s.content_hash = c.content_hash AND c.projection_json IS NOT NULL
    AND c.adapter_revision = 1 AND c.audience_policy_revision = 1
    AND ((c.provider = 'google' AND c.adapter_capabilities = '["generic-text","qr-code","reviewed-artwork"]')
      OR (c.provider = 'samsung' AND c.adapter_capabilities = '["loyalty-text","qr-code","reviewed-artwork"]'))
)
BEGIN SELECT RAISE(ABORT, 'stale provider projection source'); END;

-- Same reason, for the approval keyset check of 0043.
DROP TRIGGER wallet_provider_approval_keyset_insert;
CREATE TRIGGER wallet_provider_approval_keyset_insert BEFORE INSERT ON template_approvals
WHEN EXISTS (SELECT 1 FROM template_candidates c WHERE c.id = NEW.candidate_id AND c.provider IN ('google', 'samsung'))
  AND NOT EXISTS (SELECT 1 FROM template_candidates c JOIN credential_ref_keyset keyset
    ON keyset.id = 1 AND keyset.commitment = c.credential_keyset_commitment
    WHERE c.id = NEW.candidate_id AND c.provider IN ('google', 'samsung')
      AND c.credential_keyset_commitment = NEW.credential_keyset_commitment)
BEGIN SELECT RAISE(ABORT, 'provider approval keyset unavailable'); END;

DROP TRIGGER template_approvals_insert;
CREATE TRIGGER template_approvals_insert BEFORE INSERT ON template_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM template_candidates c
  WHERE c.id = NEW.candidate_id AND c.candidate_hash = NEW.candidate_hash
    AND (
      (NEW.kind = 'peer' AND c.author_id != NEW.reviewer_id
        AND (c.version_author_id IS NULL OR (c.author_id = 'system:wallet-projection' AND c.provider = 'google') OR c.version_author_id != NEW.reviewer_id))
      OR (NEW.kind = 'test' AND c.provider = 'apple' AND c.mode = 'test'
        AND (NEW.reviewer_id = c.author_id OR NEW.reviewer_id = c.version_author_id)
        AND EXISTS (SELECT 1 FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.user_id = NEW.reviewer_id AND m.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer'))))
      OR (NEW.kind = 'sole' AND c.provider = 'apple' AND c.org_id IS NOT NULL
        AND (SELECT count(*) FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer'))) = 1
        AND EXISTS (SELECT 1 FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.user_id = NEW.reviewer_id AND m.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer')))
        AND NOT EXISTS (SELECT 1 FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.revoked_at > NEW.created_at - 604800000
            AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer'))))
    )
)
BEGIN SELECT RAISE(ABORT, 'invalid template approval'); END;

DROP TRIGGER template_provider_releases_insert;
CREATE TRIGGER template_provider_releases_insert BEFORE INSERT ON template_releases
WHEN NEW.provider IN ('google', 'samsung')
BEGIN
  SELECT CASE WHEN NEW.source != 'approved' OR NEW.org_id IS NULL
    OR NEW.generation != COALESCE((SELECT MAX(r.generation) FROM template_releases r
      WHERE r.template_id = NEW.template_id AND r.org_id = NEW.org_id
        AND r.mode = NEW.mode AND r.provider = NEW.provider), 0) + 1
    OR NEW.previous_release_id IS NOT (SELECT r.id FROM template_releases r
      WHERE r.template_id = NEW.template_id AND r.org_id = NEW.org_id
        AND r.mode = NEW.mode AND r.provider = NEW.provider ORDER BY r.generation DESC LIMIT 1)
    THEN RAISE(ABORT, 'stale provider release') END;
  -- Validate the same immutable candidate in bounded predicates: combining the expanded
  -- Apple source view and nested provider evidence exceeds D1's expression-depth limit.
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
    JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.version
    JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = c.provider
      AND account.authority_epoch = c.provider_account_epoch
      AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    WHERE c.id = NEW.candidate_id AND a.id = NEW.approval_id AND c.template_id = NEW.template_id
      AND c.org_id = NEW.org_id AND c.mode = NEW.mode AND c.provider = NEW.provider AND c.version = NEW.version
      AND c.candidate_hash = NEW.candidate_hash AND a.candidate_hash = c.candidate_hash
      AND c.content_hash = NEW.content_hash AND c.adapter_revision = NEW.adapter_revision
      AND c.adapter_capabilities = NEW.adapter_capabilities AND c.audience_policy_revision = NEW.audience_policy_revision
      AND a.reviewer_id != c.author_id
      AND (c.version_author_id IS NULL OR (c.author_id = 'system:wallet-projection' AND c.provider = 'google') OR a.reviewer_id != c.version_author_id)
      AND (a.reviewer_id != 'system:wallet-projection:auto' OR (c.author_id = 'system:wallet-projection' AND NEW.created_by = 'system:wallet-projection:auto'
        AND json_array_length(json_extract(c.projection_json, '$.approvedOmissions')) = 0))
      AND NEW.created_by IS NOT NULL
      AND v.created_by IS c.version_author_id AND c.projection_json IS NOT NULL
      AND json_extract(c.projection_json, '$.schema') = CASE c.provider WHEN 'google' THEN 2 ELSE 1 END
      AND c.adapter_revision = 1 AND c.audience_policy_revision = 1
      AND ((c.provider = 'google' AND c.adapter_capabilities = '["generic-text","qr-code","reviewed-artwork"]')
        OR (c.provider = 'samsung' AND c.adapter_capabilities = '["loyalty-text","qr-code","reviewed-artwork"]'))
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM template_candidates c
    JOIN template_provider_apple_sources s ON s.id = c.source_release_id
    WHERE c.id = NEW.candidate_id
      AND s.template_id = c.template_id AND s.mode = c.mode AND s.version = c.version
      AND (s.org_id = c.org_id OR (s.org_id IS NULL AND s.origin = 'baked' AND s.template_org_id IS NULL))
      AND s.generation = c.source_release_generation AND s.candidate_hash = c.source_release_hash
      AND s.content_hash = c.content_hash
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  -- Operator review is not provider proof. Samsung needs verified card state. Google has no
  -- documented status proof, so its release rests on the compiled schema 2 pins checked above.
  SELECT CASE WHEN NEW.provider = 'samsung' AND NOT EXISTS (
    SELECT 1 FROM template_candidates c
    JOIN wallet_provider_projection_evidence ev ON ev.candidate_id = c.id
    WHERE c.id = NEW.candidate_id AND c.provider = 'samsung'
      AND ev.org_id = c.org_id AND ev.mode = c.mode
      AND ev.account_id = c.provider_account_id AND ev.account_revision = c.provider_account_revision
      AND ev.provider_identity_hash = c.provider_identity_hash AND ev.candidate_hash = c.candidate_hash
      AND ev.card_type = json_extract(c.projection_json, '$.cardType')
      AND ev.card_sub_type = json_extract(c.projection_json, '$.cardSubType')
      AND ev.country_code = json_extract(c.projection_json, '$.countryCode')
      AND ev.status = 'verified' AND ev.testing_mode_off = 'Y'
      AND ev.verified_at <= NEW.created_at AND ev.expires_at > NEW.created_at
      AND ev.expires_at > ev.verified_at AND ev.expires_at <= ev.verified_at + 300000
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  SELECT CASE WHEN NEW.provider = 'samsung' AND NOT EXISTS (
    SELECT 1 FROM wallet_provider_projection_evidence ev
    JOIN wallet_provider_projection_evidence_history eh ON eh.id = ev.probe_id
    WHERE ev.candidate_id = NEW.candidate_id AND eh.candidate_id = ev.candidate_id
      AND eh.org_id = ev.org_id AND eh.mode = ev.mode
      AND eh.account_id = ev.account_id AND eh.account_revision = ev.account_revision
      AND eh.candidate_hash = ev.candidate_hash AND eh.provider_identity_hash = ev.provider_identity_hash
      AND eh.card_type = ev.card_type AND eh.card_sub_type = ev.card_sub_type
      AND eh.country_code = ev.country_code AND eh.testing_mode_off = ev.testing_mode_off
      AND eh.verified_at = ev.verified_at AND eh.expires_at = ev.expires_at
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  SELECT CASE WHEN NEW.action = 'release' AND EXISTS (
    SELECT 1 FROM template_releases r WHERE r.candidate_id = NEW.candidate_id AND r.source = 'approved'
  ) THEN RAISE(ABORT, 'provider candidate already released') END;
  SELECT CASE WHEN NEW.action = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM template_releases r WHERE r.id = NEW.rollback_of_release_id AND r.source = 'approved'
      AND r.template_id = NEW.template_id AND r.org_id = NEW.org_id AND r.mode = NEW.mode
      AND r.provider = NEW.provider AND r.generation < NEW.generation - 1
      AND r.candidate_id = NEW.candidate_id AND r.approval_id = NEW.approval_id
      AND r.candidate_hash = NEW.candidate_hash AND r.version = NEW.version
  ) THEN RAISE(ABORT, 'invalid provider rollback') END;
  SELECT CASE WHEN NEW.adapter_revision < COALESCE((
    SELECT r.adapter_revision FROM template_releases r WHERE r.template_id = NEW.template_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider
    ORDER BY r.generation DESC LIMIT 1), 0) OR NEW.audience_policy_revision < COALESCE((
    SELECT r.audience_policy_revision FROM template_releases r WHERE r.template_id = NEW.template_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider
    ORDER BY r.generation DESC LIMIT 1), 0) THEN RAISE(ABORT, 'stale provider policy') END;
END;


-- BEFORE triggers fire newest first: recreate the keyset check unchanged so it still runs first.
DROP TRIGGER wallet_provider_release_keyset_insert;
CREATE TRIGGER wallet_provider_release_keyset_insert BEFORE INSERT ON template_releases
WHEN NEW.provider IN ('google', 'samsung') AND NOT EXISTS (
  SELECT 1 FROM template_candidates c JOIN credential_ref_keyset keyset
    ON keyset.id = 1 AND keyset.commitment = c.credential_keyset_commitment
  JOIN template_approvals approval ON approval.id = NEW.approval_id AND approval.candidate_id = c.id
  WHERE c.id = NEW.candidate_id AND c.provider = NEW.provider
    AND c.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND approval.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND (NEW.action != 'rollback' OR EXISTS (SELECT 1 FROM template_releases prior
      WHERE prior.id = NEW.rollback_of_release_id
        AND prior.credential_keyset_commitment = NEW.credential_keyset_commitment)))
BEGIN SELECT RAISE(ABORT, 'provider release keyset unavailable'); END;
