-- A native candidate extends the same reviewed template-release lifecycle. Apple rows remain
-- unchanged; the extra columns bind a provider projection to one immutable Apple source release.
ALTER TABLE template_candidates ADD COLUMN source_release_id TEXT REFERENCES template_releases(id);
ALTER TABLE template_candidates ADD COLUMN source_release_generation INTEGER;
ALTER TABLE template_candidates ADD COLUMN source_release_hash TEXT;
ALTER TABLE template_candidates ADD COLUMN projection_json TEXT;
ALTER TABLE template_candidates ADD COLUMN provider_account_id TEXT REFERENCES wallet_provider_accounts(id);
ALTER TABLE template_candidates ADD COLUMN provider_account_revision INTEGER;
ALTER TABLE template_candidates ADD COLUMN provider_identity_hash TEXT;
CREATE INDEX template_candidates_source_release_fk ON template_candidates(source_release_id);
CREATE INDEX template_candidates_provider_account_fk ON template_candidates(provider_account_id);

-- This is provenance, not authorization for a native provider. It mirrors the effective Apple
-- source head, including the global baked-template fallback and independent Apple approval.
CREATE VIEW template_provider_apple_sources AS
SELECT r.id, r.template_id, r.org_id, r.mode, r.version, r.generation, r.candidate_hash,
       r.content_hash, t.origin, t.org_id AS template_org_id
FROM template_releases r
JOIN templates t ON t.id = r.template_id
JOIN template_versions v ON v.template_id = r.template_id AND v.version = r.version
WHERE r.provider = 'apple' AND t.status = 'active'
  AND r.adapter_revision = 1 AND r.adapter_capabilities = '["apple-passkit"]'
  AND r.audience_policy_revision = 1
  AND NOT EXISTS (SELECT 1 FROM template_releases newer
    WHERE newer.template_id = r.template_id AND newer.org_id IS r.org_id
      AND newer.mode = r.mode AND newer.provider = 'apple' AND newer.generation > r.generation)
  AND ((r.source = 'system' AND r.action = 'system' AND t.origin = 'baked'
        AND r.org_id IS t.org_id AND r.version = t.active_version
        AND r.candidate_id IS NULL AND r.approval_id IS NULL)
    OR (r.source = 'approved' AND r.action IN ('release', 'rollback') AND t.origin = 'uploaded'
        AND r.org_id IS NOT NULL AND (t.org_id IS NULL OR t.org_id = r.org_id)
        AND EXISTS (SELECT 1 FROM template_candidates c
          JOIN template_approvals a ON a.candidate_id = c.id
          WHERE c.id = r.candidate_id AND a.id = r.approval_id
            AND c.template_id = r.template_id AND c.org_id IS r.org_id AND c.mode = r.mode
            AND c.provider = 'apple' AND c.version = r.version
            AND c.candidate_hash = r.candidate_hash AND a.candidate_hash = c.candidate_hash
            AND c.content_hash = r.content_hash AND c.adapter_revision = r.adapter_revision
            AND c.adapter_capabilities = r.adapter_capabilities
            AND c.audience_policy_revision = r.audience_policy_revision
            AND v.created_by IS c.version_author_id AND a.reviewer_id != c.author_id
            AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id))));

DROP TRIGGER template_candidates_insert;
CREATE TRIGGER template_candidates_insert BEFORE INSERT ON template_candidates
WHEN NEW.provider = 'apple' AND (
  NEW.source_release_id IS NOT NULL OR NEW.source_release_generation IS NOT NULL
  OR NEW.source_release_hash IS NOT NULL OR NEW.projection_json IS NOT NULL
  OR NEW.provider_account_id IS NOT NULL OR NEW.provider_account_revision IS NOT NULL
  OR NEW.provider_identity_hash IS NOT NULL
  OR NOT EXISTS (SELECT 1 FROM templates t JOIN template_versions v
    ON v.template_id = t.id AND v.version = NEW.version
    WHERE t.id = NEW.template_id AND NEW.org_id IS NOT NULL
      AND (t.org_id IS NULL OR t.org_id = NEW.org_id)
      AND t.origin = 'uploaded' AND t.status = 'active' AND v.created_by IS NEW.version_author_id)
)
BEGIN SELECT RAISE(ABORT, 'invalid template candidate'); END;

CREATE TRIGGER template_provider_candidates_insert BEFORE INSERT ON template_candidates
WHEN NEW.provider IN ('google', 'samsung') AND NOT EXISTS (
  SELECT 1 FROM template_provider_apple_sources s
  JOIN template_versions v ON v.template_id = s.template_id AND v.version = s.version
  JOIN wallet_provider_accounts account ON account.id = NEW.provider_account_id
    AND account.org_id = NEW.org_id AND account.mode = NEW.mode AND account.provider = NEW.provider
    AND account.revision = NEW.provider_account_revision
    AND account.credential_id IS NOT NULL
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

-- No approval may be added to a projection whose exact Apple source is no longer effective.
CREATE TRIGGER template_provider_approvals_insert BEFORE INSERT ON template_approvals
WHEN EXISTS (SELECT 1 FROM template_candidates c WHERE c.id = NEW.candidate_id
  AND c.provider IN ('google', 'samsung')) AND NOT EXISTS (
  SELECT 1 FROM template_candidates c JOIN template_provider_apple_sources s ON s.id = c.source_release_id
  JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.version
  JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
    AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = c.provider
    AND account.revision = c.provider_account_revision
    AND account.credential_id IS NOT NULL
    AND account.revoked_at IS NULL
  WHERE c.id = NEW.candidate_id AND NEW.candidate_hash = c.candidate_hash
    AND NEW.reviewer_id != c.author_id AND (c.version_author_id IS NULL OR NEW.reviewer_id != c.version_author_id)
    AND v.created_by IS c.version_author_id AND s.template_id = c.template_id AND s.mode = c.mode
    AND s.version = c.version AND (s.org_id = c.org_id OR (s.org_id IS NULL AND s.origin = 'baked' AND s.template_org_id IS NULL))
    AND s.generation = c.source_release_generation AND s.candidate_hash = c.source_release_hash
    AND s.content_hash = c.content_hash AND c.projection_json IS NOT NULL
    AND c.adapter_revision = 1 AND c.audience_policy_revision = 1
    AND ((c.provider = 'google' AND c.adapter_capabilities = '["generic-text","qr-code","reviewed-artwork"]')
      OR (c.provider = 'samsung' AND c.adapter_capabilities = '["loyalty-text","qr-code","reviewed-artwork"]'))
)
BEGIN SELECT RAISE(ABORT, 'stale provider projection source'); END;

-- Preserve the complete Apple restore trigger from 0036 without broadening Apple semantics.
DROP TRIGGER template_releases_insert;
CREATE TRIGGER template_releases_insert BEFORE INSERT ON template_releases
WHEN NEW.provider = 'apple'
BEGIN
  SELECT CASE WHEN NEW.generation != COALESCE((
    SELECT MAX(r.generation) FROM template_releases r
    WHERE r.template_id = NEW.template_id AND r.org_id IS NEW.org_id
      AND r.mode = NEW.mode AND r.provider = NEW.provider
  ), 0) + 1 OR NEW.previous_release_id IS NOT (
    SELECT r.id FROM template_releases r
    WHERE r.template_id = NEW.template_id AND r.org_id IS NEW.org_id
      AND r.mode = NEW.mode AND r.provider = NEW.provider ORDER BY r.generation DESC LIMIT 1
  ) THEN RAISE(ABORT, 'stale template release') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM templates t WHERE t.id = NEW.template_id
      AND ((NEW.source = 'system' AND t.origin = 'baked' AND t.org_id IS NEW.org_id
          AND t.status = 'active' AND t.active_version = NEW.version)
        -- Cutover amendment: a legacy release pins the template's current active version.
        OR (NEW.source = 'legacy' AND t.origin = 'uploaded' AND NEW.org_id IS NOT NULL
          AND (t.org_id IS NULL OR t.org_id = NEW.org_id)
          AND t.status = 'active' AND t.active_version = NEW.version)
        OR (NEW.source = 'approved' AND t.origin = 'uploaded' AND NEW.org_id IS NOT NULL
          AND (t.org_id IS NULL OR t.org_id = NEW.org_id)
          AND (t.status = 'active' OR (t.status = 'archived' AND NEW.mode = 'live' AND t.org_id = NEW.org_id))))
  ) THEN RAISE(ABORT, 'invalid template release scope') END;
  SELECT CASE WHEN NEW.source = 'legacy' AND EXISTS (
    SELECT 1 FROM template_releases r WHERE r.template_id = NEW.template_id AND r.org_id IS NEW.org_id
      AND r.mode = NEW.mode AND r.provider = NEW.provider
  ) THEN RAISE(ABORT, 'legacy release requires an empty scope') END;
  SELECT CASE WHEN NEW.source = 'approved' AND NOT EXISTS (
    SELECT 1 FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
    WHERE c.id = NEW.candidate_id AND a.id = NEW.approval_id
      AND c.template_id = NEW.template_id AND c.org_id IS NEW.org_id
      AND c.mode = NEW.mode AND c.provider = NEW.provider AND c.version = NEW.version
      AND c.candidate_hash = NEW.candidate_hash AND a.candidate_hash = c.candidate_hash
      AND c.content_hash = NEW.content_hash AND c.adapter_revision = NEW.adapter_revision
      AND c.adapter_capabilities = NEW.adapter_capabilities
      AND c.audience_policy_revision = NEW.audience_policy_revision
      AND a.reviewer_id != c.author_id AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)
  ) THEN RAISE(ABORT, 'invalid template release approval') END;
  SELECT CASE WHEN NEW.action = 'release' AND EXISTS (
    SELECT 1 FROM template_releases r WHERE r.candidate_id = NEW.candidate_id AND r.source = 'approved'
  ) THEN RAISE(ABORT, 'template candidate already released') END;
  SELECT CASE WHEN NEW.action = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM template_releases r WHERE r.id = NEW.rollback_of_release_id AND r.source = 'approved'
      AND r.template_id = NEW.template_id AND r.org_id IS NEW.org_id AND r.mode = NEW.mode
      AND r.provider = NEW.provider AND (r.generation < NEW.generation - 1 OR (
        r.generation = NEW.generation - 1 AND NEW.mode = 'live'
        AND EXISTS (SELECT 1 FROM templates restore_template WHERE restore_template.id = NEW.template_id
          AND restore_template.status = 'archived' AND restore_template.org_id = NEW.org_id)))
      AND r.candidate_id = NEW.candidate_id AND r.approval_id = NEW.approval_id
      AND r.candidate_hash = NEW.candidate_hash AND r.version = NEW.version
  ) THEN RAISE(ABORT, 'invalid template rollback') END;
  SELECT CASE WHEN NEW.adapter_revision < COALESCE((
    SELECT r.adapter_revision FROM template_releases r WHERE r.template_id = NEW.template_id
      AND r.org_id IS NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider
    ORDER BY r.generation DESC LIMIT 1), 0) OR NEW.audience_policy_revision < COALESCE((
    SELECT r.audience_policy_revision FROM template_releases r WHERE r.template_id = NEW.template_id
      AND r.org_id IS NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider
    ORDER BY r.generation DESC LIMIT 1), 0) THEN RAISE(ABORT, 'stale template policy') END;
END;

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
      AND account.revision = c.provider_account_revision
      AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    WHERE c.id = NEW.candidate_id AND a.id = NEW.approval_id AND c.template_id = NEW.template_id
      AND c.org_id = NEW.org_id AND c.mode = NEW.mode AND c.provider = NEW.provider AND c.version = NEW.version
      AND c.candidate_hash = NEW.candidate_hash AND a.candidate_hash = c.candidate_hash
      AND c.content_hash = NEW.content_hash AND c.adapter_revision = NEW.adapter_revision
      AND c.adapter_capabilities = NEW.adapter_capabilities AND c.audience_policy_revision = NEW.audience_policy_revision
      AND a.reviewer_id != c.author_id AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)
      AND NEW.created_by IS NOT NULL
      AND v.created_by IS c.version_author_id AND c.projection_json IS NOT NULL
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
  -- Operator review is not provider proof. Google has no documented status proof yet.
  SELECT CASE WHEN NOT EXISTS (
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
  SELECT CASE WHEN NOT EXISTS (
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
