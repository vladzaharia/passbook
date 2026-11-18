-- Sole-reviewer and test-mode approvals (PS-01). An approval is `peer` (an independent reviewer),
-- `sole` (the org's only eligible reviewer, none removed in the last 7 days) or `test` (Test mode).
-- The database refuses a self-approval that is neither, and counts reviewers inside the insert.
ALTER TABLE template_approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'peer'
  CHECK (kind IN ('peer', 'sole', 'test'));

DROP TRIGGER template_approvals_insert;
CREATE TRIGGER template_approvals_insert BEFORE INSERT ON template_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM template_candidates c
  WHERE c.id = NEW.candidate_id AND c.candidate_hash = NEW.candidate_hash
    AND (
      (NEW.kind = 'peer' AND c.author_id != NEW.reviewer_id
        AND (c.version_author_id IS NULL OR c.version_author_id != NEW.reviewer_id))
      OR (NEW.kind = 'test' AND c.provider = 'apple' AND c.mode = 'test')
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

-- The Apple release trigger from 0038, with independence required only of peer approvals.
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
      AND (a.kind != 'peer' OR (a.reviewer_id != c.author_id
        AND (c.version_author_id IS NULL OR a.reviewer_id != c.version_author_id)))
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
