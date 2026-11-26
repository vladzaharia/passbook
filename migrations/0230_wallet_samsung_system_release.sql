-- Samsung system release (CAND-1). 0141 exempted the platform author from the version-author check for Google
-- candidates only, so a Samsung system release was refused at approval, at release, and by the retirement and
-- tombstone proofs. The exemption now covers Samsung too. Only the author `system:wallet-projection` is exempt, and
-- the system reviewer may approve only a system candidate with no approved omissions. `reviewer != author`, the
-- human-candidate rule and every other term are unchanged. Each object is recreated from its 0224 body.

DROP TRIGGER template_approvals_insert;
CREATE TRIGGER template_approvals_insert BEFORE INSERT ON template_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM template_candidates c
  WHERE c.id = NEW.candidate_id AND c.candidate_hash = NEW.candidate_hash
    AND (
      (NEW.kind = 'peer' AND c.author_id != NEW.reviewer_id
        AND (c.version_author_id IS NULL OR (c.author_id = 'system:wallet-projection' AND c.provider IN ('google', 'samsung')) OR c.version_author_id != NEW.reviewer_id))
      OR (NEW.kind = 'test' AND c.provider = 'apple' AND c.mode = 'test'
        AND (NEW.reviewer_id = c.author_id OR NEW.reviewer_id = c.version_author_id)
        AND EXISTS (SELECT 1 FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.user_id = NEW.reviewer_id AND m.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer'))))
      OR (NEW.kind = 'sole' AND c.provider IN ('apple', 'google', 'samsung') AND c.org_id IS NOT NULL
        AND (SELECT count(*) FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer'))) = 1
        AND EXISTS (SELECT 1 FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.user_id = NEW.reviewer_id AND m.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer'))))
    )
)
BEGIN SELECT RAISE(ABORT, 'invalid template approval'); END;

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
    AND (NEW.kind = 'sole' OR NEW.reviewer_id != c.author_id)
    AND (NEW.kind = 'sole' OR c.version_author_id IS NULL OR (c.author_id = 'system:wallet-projection' AND c.provider IN ('google', 'samsung')) OR NEW.reviewer_id != c.version_author_id)
    AND (NEW.reviewer_id != 'system:wallet-projection:auto' OR (c.author_id = 'system:wallet-projection' AND c.provider IN ('google', 'samsung')
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
      AND (a.kind = 'sole' OR a.reviewer_id != c.author_id)
      AND (a.kind = 'sole' OR c.version_author_id IS NULL OR (c.author_id = 'system:wallet-projection' AND c.provider IN ('google', 'samsung')) OR a.reviewer_id != c.version_author_id)
      AND (a.reviewer_id != 'system:wallet-projection:auto' OR (c.author_id = 'system:wallet-projection' AND NEW.created_by = 'system:wallet-projection:auto'
        AND json_array_length(json_extract(c.projection_json, '$.approvedOmissions')) = 0))
      AND (NEW.action != 'release' OR a.kind != 'sole' OR (NOT EXISTS (SELECT 1 FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.created_at > a.created_at AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer')))
        AND (SELECT count(*) FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer'))) = 1
        AND EXISTS (SELECT 1 FROM org_memberships m
          WHERE m.org_id = c.org_id AND m.user_id = a.reviewer_id AND m.revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value IN ('org_admin', 'template_reviewer')))))
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

DROP TRIGGER wallet_samsung_tombstone_keyset_insert;
CREATE TRIGGER wallet_samsung_tombstone_keyset_insert BEFORE INSERT ON wallet_samsung_tombstones
WHEN NOT EXISTS (SELECT 1 FROM template_releases projection_release
  JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id
  JOIN template_approvals approval ON approval.id = projection_release.approval_id AND approval.candidate_id = candidate.id
  LEFT JOIN wallet_provider_projection_evidence_history evidence ON evidence.candidate_id = candidate.id
  JOIN credential_ref_keyset keyset ON keyset.id = 1 AND keyset.commitment = NEW.credential_keyset_commitment
  WHERE projection_release.id = NEW.release_id AND candidate.id = NEW.candidate_id
    AND projection_release.org_id = NEW.org_id AND projection_release.mode = NEW.mode AND projection_release.provider = 'samsung'
    AND candidate.provider_account_id = NEW.account_id AND candidate.provider_account_revision = NEW.account_revision
    AND candidate.provider_identity_hash = NEW.provider_identity_hash
    AND candidate.org_id = NEW.org_id AND candidate.mode = NEW.mode AND candidate.provider = 'samsung'
    AND projection_release.source = 'approved' AND projection_release.candidate_hash = candidate.candidate_hash
    AND approval.candidate_hash = candidate.candidate_hash AND (approval.kind = 'sole' OR approval.reviewer_id != candidate.author_id)
    AND (approval.kind = 'sole' OR candidate.version_author_id IS NULL OR (candidate.author_id = 'system:wallet-projection' AND candidate.provider IN ('google', 'samsung')) OR approval.reviewer_id != candidate.version_author_id)
    AND projection_release.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND candidate.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND approval.credential_keyset_commitment = NEW.credential_keyset_commitment
    AND (json_extract(candidate.projection_json, '$.schema') = 2 OR (
      evidence.credential_keyset_commitment = NEW.credential_keyset_commitment
      AND evidence.org_id = NEW.org_id AND evidence.mode = NEW.mode AND evidence.account_id = NEW.account_id
      AND evidence.account_revision = NEW.account_revision AND evidence.candidate_hash = candidate.candidate_hash
      AND evidence.provider_identity_hash = NEW.provider_identity_hash
      AND evidence.card_type = json_extract(candidate.projection_json, '$.cardType')
      AND evidence.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
      AND evidence.country_code = json_extract(candidate.projection_json, '$.countryCode')
      AND evidence.testing_mode_off = 'Y' AND evidence.verified_at <= projection_release.created_at
      AND projection_release.created_at < evidence.expires_at)))
BEGIN SELECT RAISE(ABORT, 'Samsung tombstone keyset unavailable'); END;

DROP VIEW wallet_provider_retirement_complete;
DROP VIEW wallet_provider_retirement_complete_base;
CREATE VIEW wallet_provider_retirement_complete_base AS
SELECT i.id FROM wallet_provider_instances i
WHERE i.lifecycle = 'retired'
  AND EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1
    AND keyset.commitment = i.credential_keyset_commitment)
  AND (
  (i.retirement_reason = 'not_issued' AND i.account_id IS NULL AND i.identity_projection_release_id IS NULL
    AND i.desired_version = 0 AND i.desired_operation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations op WHERE op.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_offer_refs o WHERE o.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs r WHERE r.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_bindings b WHERE b.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_callback_events e WHERE e.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_callback_receipts r WHERE r.instance_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM wallet_google_callback_receipts r WHERE r.instance_id = i.id))
  OR (i.provider = 'samsung' AND i.retirement_reason IS NULL AND i.retirement_requested_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM wallet_provider_accounts a WHERE a.id = i.account_id
      AND a.org_id = i.org_id AND a.mode = i.mode AND a.provider = i.provider)
    AND EXISTS (SELECT 1 FROM template_releases projection_release
      JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id
      JOIN template_approvals approval ON approval.id = projection_release.approval_id AND approval.candidate_id = candidate.id
      LEFT JOIN wallet_provider_projection_evidence_history evidence ON evidence.candidate_id = candidate.id
      WHERE (
        projection_release.id = i.identity_projection_release_id AND projection_release.org_id = i.org_id
        AND projection_release.mode = i.mode AND projection_release.provider = 'samsung' AND projection_release.source = 'approved'
        AND candidate.provider_account_id = i.account_id
        AND candidate.org_id = i.org_id AND candidate.mode = i.mode AND candidate.provider = 'samsung'
      ) AND (
        projection_release.candidate_hash = candidate.candidate_hash AND approval.candidate_hash = candidate.candidate_hash
        AND (approval.kind = 'sole' OR approval.reviewer_id != candidate.author_id)
        AND (approval.kind = 'sole' OR candidate.version_author_id IS NULL OR (candidate.author_id = 'system:wallet-projection' AND candidate.provider IN ('google', 'samsung')) OR approval.reviewer_id != candidate.version_author_id)
        AND projection_release.credential_keyset_commitment = i.credential_keyset_commitment
        AND candidate.credential_keyset_commitment = i.credential_keyset_commitment
        AND approval.credential_keyset_commitment = i.credential_keyset_commitment
      ) AND (json_extract(candidate.projection_json, '$.schema') = 2 OR (
        evidence.credential_keyset_commitment = i.credential_keyset_commitment
        AND evidence.org_id = i.org_id AND evidence.mode = i.mode AND evidence.account_id = i.account_id
        AND evidence.account_revision = candidate.provider_account_revision AND evidence.candidate_hash = candidate.candidate_hash
        AND evidence.provider_identity_hash = candidate.provider_identity_hash
        AND evidence.card_type = json_extract(candidate.projection_json, '$.cardType')
        AND evidence.card_sub_type = json_extract(candidate.projection_json, '$.cardSubType')
        AND evidence.country_code = json_extract(candidate.projection_json, '$.countryCode')
        AND evidence.testing_mode_off = 'Y' AND evidence.verified_at <= projection_release.created_at
        AND projection_release.created_at < evidence.expires_at
      )))
    AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations op
      WHERE op.id = i.desired_operation_id AND op.instance_id = i.id AND op.version = i.desired_version
        AND op.kind = 'revoke' AND op.state = 'succeeded'
        AND op.credential_keyset_commitment = i.credential_keyset_commitment)
    AND NOT EXISTS (SELECT 1 FROM wallet_provider_instance_operations busy
      WHERE busy.instance_id = i.id AND busy.state IN ('pending', 'retry', 'claimed', 'uncertain'))
    AND NOT EXISTS (SELECT 1 FROM wallet_samsung_fetch_refs ref WHERE ref.instance_id = i.id
      AND NOT EXISTS (SELECT 1 FROM wallet_samsung_tombstones t
        JOIN template_releases r ON r.id = i.identity_projection_release_id
        JOIN template_candidates c ON c.id = r.candidate_id
        WHERE (
          ref.credential_keyset_commitment = i.credential_keyset_commitment
          AND t.credential_keyset_commitment = i.credential_keyset_commitment
          AND t.ref_hash = ref.ref_hash AND t.org_id = i.org_id AND t.mode = i.mode
          AND t.account_id = i.account_id AND t.release_id = r.id AND t.candidate_id = c.id
        ) AND (
          r.credential_keyset_commitment = i.credential_keyset_commitment
          AND c.credential_keyset_commitment = i.credential_keyset_commitment
          AND c.provider_account_id = i.account_id AND t.account_revision = c.provider_account_revision
          AND t.provider_identity_hash = c.provider_identity_hash
        )
      )
    )
  )
);
CREATE VIEW wallet_provider_retirement_complete AS
SELECT id FROM wallet_provider_retirement_complete_base
UNION ALL
SELECT id FROM wallet_google_retirement_complete;

-- The candidate backfill stamps an enrolment once it has queued provider candidates for the org's Apple releases.
-- Pending while unstamped or stamped before the enrolment was last turned On.
ALTER TABLE wallet_provider_accounts ADD COLUMN projection_backfilled_at INTEGER
  CHECK (projection_backfilled_at IS NULL OR (typeof(projection_backfilled_at) = 'integer' AND projection_backfilled_at >= 0));
