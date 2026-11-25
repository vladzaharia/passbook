-- A credential is present on either model: a legacy envelope (credential_id) or a new-model enrolment's
-- source (credential_source_id). The projection, successor and binding triggers tested credential_id alone, so a
-- new-model-only account could not release a projection or activate a placeholder. Each is recreated with the
-- presence test COALESCE(x.credential_id, x.credential_source_id) IS NOT NULL; every other term is unchanged.
-- Whether the enrolment may issue stays with the enrolment gate triggers (wallet_enrolment_gate_*).

DROP TRIGGER template_provider_candidates_insert;
CREATE TRIGGER template_provider_candidates_insert BEFORE INSERT ON template_candidates
WHEN NEW.provider IN ('google', 'samsung') AND NOT EXISTS (
  SELECT 1 FROM template_provider_apple_sources s
  JOIN template_versions v ON v.template_id = s.template_id AND v.version = s.version
  JOIN wallet_provider_accounts account ON account.id = NEW.provider_account_id
    AND account.org_id = NEW.org_id AND account.mode = NEW.mode AND account.provider = NEW.provider
    AND account.revision = NEW.provider_account_revision
    AND COALESCE(account.credential_id, account.credential_source_id) IS NOT NULL
    AND account.revoked_at IS NULL
  WHERE NEW.org_id IS NOT NULL AND s.id = NEW.source_release_id
    AND s.template_id = NEW.template_id AND s.mode = NEW.mode AND s.version = NEW.version
    AND (s.org_id = NEW.org_id OR (s.org_id IS NULL AND s.origin = 'baked' AND s.template_org_id IS NULL))
    AND s.generation = NEW.source_release_generation AND s.candidate_hash = NEW.source_release_hash
    AND s.content_hash = NEW.content_hash AND v.created_by IS NEW.version_author_id
    AND NEW.projection_json IS NOT NULL AND json_valid(NEW.projection_json)
    AND json_type(NEW.projection_json) = 'object'
    AND length(NEW.provider_identity_hash) = 64 AND NEW.provider_identity_hash NOT GLOB '*[^0-9a-f]*'
    AND json_extract(NEW.projection_json, '$.provider') = NEW.provider
    AND NEW.adapter_revision = 1 AND NEW.audience_policy_revision = 1
    AND ((NEW.provider = 'google' AND NEW.adapter_capabilities = '["generic-text","qr-code","reviewed-artwork"]')
      OR (NEW.provider = 'samsung' AND NEW.adapter_capabilities = '["loyalty-text","qr-code","reviewed-artwork"]'))
)
BEGIN SELECT RAISE(ABORT, 'invalid provider projection candidate'); END;

DROP TRIGGER template_provider_approvals_insert;
CREATE TRIGGER template_provider_approvals_insert BEFORE INSERT ON template_approvals
WHEN EXISTS (SELECT 1 FROM template_candidates c WHERE c.id = NEW.candidate_id
  AND c.provider IN ('google', 'samsung')) AND NOT EXISTS (
  SELECT 1 FROM template_candidates c JOIN template_provider_apple_sources s ON s.id = c.source_release_id
  JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.version
  JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
    AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = c.provider
    AND account.authority_epoch = c.provider_account_epoch
    AND COALESCE(account.credential_id, account.credential_source_id) IS NOT NULL
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
      AND COALESCE(account.credential_id, account.credential_source_id) IS NOT NULL
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
      AND json_extract(c.projection_json, '$.schema') = 2
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
  -- Operator review is not provider proof. A Samsung release needs a fresh card-state row from a live read;
  -- Google has no documented status proof, so its release rests on the compiled pins checked above.
  SELECT CASE WHEN NEW.provider = 'samsung' AND NOT EXISTS (
    SELECT 1 FROM template_candidates c JOIN wallet_samsung_card_state st ON st.candidate_id = c.id
    WHERE c.id = NEW.candidate_id AND st.candidate_hash = c.candidate_hash
      AND st.account_id = c.provider_account_id AND st.account_epoch = c.provider_account_epoch
      AND st.card_type = json_extract(c.projection_json, '$.type')
      AND ((st.state = 'ACTIVE' AND st.testing_mode_off = 'Y') OR (NEW.mode = 'test' AND st.state IN ('ACTIVE', 'DRAFT', 'VERIFYING', 'VERIFIED')))
      AND st.verified_at <= NEW.created_at AND NEW.created_at < st.expires_at
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

DROP TRIGGER wallet_provider_instances_successor;
CREATE TRIGGER wallet_provider_instances_successor BEFORE INSERT ON wallet_provider_instances
WHEN NEW.channel_epoch > 1 AND (
  NEW.lifecycle != 'active' OR NEW.retirement_requested_at IS NOT NULL OR NEW.retirement_cause IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = NEW.credential_keyset_commitment)
  OR NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
    AND p.credential_generation = NEW.credential_generation)
  OR EXISTS (SELECT 1 FROM pass_credential_transfers pending WHERE pending.pass_id = NEW.pass_id
    AND pending.state = 'pending')
  OR NOT EXISTS (
    SELECT 1 FROM wallet_provider_accounts a
    JOIN template_releases r ON r.id = NEW.identity_projection_release_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider AND r.source = 'approved'
    JOIN template_candidates c ON c.id = r.candidate_id AND c.provider_account_id = a.id
      AND c.provider_account_revision = a.revision
    WHERE a.id = NEW.account_id AND a.org_id = NEW.org_id AND a.mode = NEW.mode
      AND a.provider = NEW.provider AND COALESCE(a.credential_id, a.credential_source_id) IS NOT NULL AND a.revoked_at IS NULL
      AND (a.credential_source_id IS NULL OR (a.enabled_at IS NOT NULL AND a.platform_hold_at IS NULL))
  )
  OR NOT EXISTS (
    SELECT 1 FROM wallet_provider_instances pred
    WHERE pred.pass_id = NEW.pass_id AND pred.provider = NEW.provider
      AND pred.credential_generation = NEW.credential_generation AND pred.channel_epoch = NEW.channel_epoch - 1
      AND pred.org_id = NEW.org_id AND pred.mode = NEW.mode
      AND pred.retirement_cause = 'channel_off' AND pred.lifecycle IN ('revoked', 'retired')
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.id = pred.desired_operation_id
        AND op.instance_id = pred.id AND op.kind = 'revoke' AND op.state = 'succeeded')
      AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy WHERE busy.instance_id = pred.id
        AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
  )
  OR EXISTS (SELECT 1 FROM pass_channels c WHERE c.pass_id = NEW.pass_id AND c.channel = NEW.provider
    AND c.retired_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'provider successor is not allowed'); END;

DROP TRIGGER wallet_provider_instances_binding_immutable;
CREATE TRIGGER wallet_provider_instances_binding_immutable
BEFORE UPDATE OF account_id, identity_projection_release_id ON wallet_provider_instances
WHEN (OLD.account_id IS NOT NEW.account_id OR OLD.identity_projection_release_id IS NOT NEW.identity_projection_release_id)
  AND NOT (OLD.lifecycle = 'ready' AND NEW.lifecycle = 'active'
    AND OLD.account_id IS NULL AND OLD.identity_projection_release_id IS NULL
    AND NEW.account_id IS NOT NULL AND NEW.identity_projection_release_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM wallet_provider_accounts a
      JOIN template_releases r ON r.id = NEW.identity_projection_release_id
        AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider AND r.source = 'approved'
      JOIN template_candidates c ON c.id = r.candidate_id AND c.provider_account_id = a.id
        AND c.provider_account_epoch = a.authority_epoch
      JOIN wallet_provider_instance_operations op ON op.id = NEW.desired_operation_id
        AND op.instance_id = NEW.id AND op.version = NEW.desired_version AND op.kind = 'upsert'
        AND op.pass_credential_generation = NEW.credential_generation
      WHERE a.id = NEW.account_id AND a.org_id = NEW.org_id AND a.mode = NEW.mode
        AND a.provider = NEW.provider AND COALESCE(a.credential_id, a.credential_source_id) IS NOT NULL AND a.revoked_at IS NULL
    ))
BEGIN SELECT RAISE(ABORT, 'provider instance binding is immutable'); END;
