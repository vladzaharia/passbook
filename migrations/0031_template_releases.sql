-- Reviewed candidates and releases are append-only. The short template version key is not the
-- approval digest: both the full content digest and the scoped candidate digest are retained.
CREATE TABLE template_candidates (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  org_id TEXT REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'samsung')),
  version TEXT NOT NULL,
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  adapter_revision INTEGER NOT NULL CHECK (adapter_revision > 0),
  adapter_capabilities TEXT NOT NULL CHECK (json_valid(adapter_capabilities) AND json_type(adapter_capabilities) = 'array'),
  audience_policy_revision INTEGER NOT NULL CHECK (audience_policy_revision > 0),
  author_id TEXT NOT NULL,
  version_author_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version)
);
CREATE INDEX template_candidates_scope ON template_candidates(template_id, org_id, mode, provider, created_at DESC);
CREATE TRIGGER template_candidates_insert BEFORE INSERT ON template_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM templates t JOIN template_versions v ON v.template_id = t.id AND v.version = NEW.version
  WHERE t.id = NEW.template_id AND NEW.org_id IS NOT NULL
    AND (t.org_id IS NULL OR t.org_id = NEW.org_id)
    AND t.origin = 'uploaded' AND t.status = 'active' AND v.created_by IS NEW.version_author_id
)
BEGIN SELECT RAISE(ABORT, 'invalid template candidate'); END;
CREATE TRIGGER template_candidates_immutable BEFORE UPDATE ON template_candidates
BEGIN SELECT RAISE(ABORT, 'template candidates are immutable'); END;
CREATE TRIGGER template_candidates_no_delete BEFORE DELETE ON template_candidates
BEGIN SELECT RAISE(ABORT, 'template candidates are immutable'); END;

CREATE TABLE template_approvals (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES template_candidates(id),
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'),
  reviewer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX template_approvals_candidate ON template_approvals(candidate_id, created_at DESC);
CREATE TRIGGER template_approvals_insert BEFORE INSERT ON template_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM template_candidates c
  WHERE c.id = NEW.candidate_id AND c.candidate_hash = NEW.candidate_hash
    AND c.author_id != NEW.reviewer_id
    AND (c.version_author_id IS NULL OR c.version_author_id != NEW.reviewer_id)
)
BEGIN SELECT RAISE(ABORT, 'invalid template approval'); END;
CREATE TRIGGER template_approvals_immutable BEFORE UPDATE ON template_approvals
BEGIN SELECT RAISE(ABORT, 'template approvals are immutable'); END;
CREATE TRIGGER template_approvals_no_delete BEFORE DELETE ON template_approvals
BEGIN SELECT RAISE(ABORT, 'template approvals are immutable'); END;

CREATE TABLE template_releases (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  org_id TEXT REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'samsung')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  version TEXT NOT NULL,
  candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  adapter_revision INTEGER NOT NULL CHECK (adapter_revision > 0),
  adapter_capabilities TEXT NOT NULL CHECK (json_valid(adapter_capabilities) AND json_type(adapter_capabilities) = 'array'),
  audience_policy_revision INTEGER NOT NULL CHECK (audience_policy_revision > 0),
  -- 'legacy' (cutover amendment): tools/bootstrap-tenancy.ts only, for templates uploaded before reviews existed.
  source TEXT NOT NULL CHECK (source IN ('approved', 'system', 'legacy')),
  action TEXT NOT NULL CHECK (action IN ('release', 'rollback', 'system', 'legacy')),
  candidate_id TEXT REFERENCES template_candidates(id),
  approval_id TEXT REFERENCES template_approvals(id),
  previous_release_id TEXT REFERENCES template_releases(id),
  rollback_of_release_id TEXT REFERENCES template_releases(id),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (template_id, version) REFERENCES template_versions(template_id, version),
  CHECK (
    (source = 'system' AND action = 'system' AND candidate_id IS NULL AND approval_id IS NULL
      AND rollback_of_release_id IS NULL AND created_by IS NULL)
    OR (source = 'legacy' AND action = 'legacy' AND candidate_id IS NULL AND approval_id IS NULL
      AND rollback_of_release_id IS NULL AND previous_release_id IS NULL AND generation = 1)
    OR (source = 'approved' AND action = 'release' AND candidate_id IS NOT NULL AND approval_id IS NOT NULL
      AND rollback_of_release_id IS NULL AND created_by IS NOT NULL)
    OR (source = 'approved' AND action = 'rollback' AND candidate_id IS NOT NULL AND approval_id IS NOT NULL
      AND rollback_of_release_id IS NOT NULL AND created_by IS NOT NULL)
  )
);
-- SQLite UNIQUE treats NULLs as distinct, so the platform scope needs its own index.
CREATE UNIQUE INDEX template_releases_tenant_generation
  ON template_releases(template_id, org_id, mode, provider, generation) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX template_releases_platform_generation
  ON template_releases(template_id, mode, provider, generation) WHERE org_id IS NULL;
CREATE INDEX template_releases_candidate ON template_releases(candidate_id);
CREATE TRIGGER template_releases_insert BEFORE INSERT ON template_releases
BEGIN
  SELECT CASE WHEN NEW.provider != 'apple' OR NEW.generation != COALESCE((
    SELECT MAX(r.generation) FROM template_releases r
    WHERE r.template_id = NEW.template_id AND r.org_id IS NEW.org_id
      AND r.mode = NEW.mode AND r.provider = NEW.provider
  ), 0) + 1 OR NEW.previous_release_id IS NOT (
    SELECT r.id FROM template_releases r
    WHERE r.template_id = NEW.template_id AND r.org_id IS NEW.org_id
      AND r.mode = NEW.mode AND r.provider = NEW.provider ORDER BY r.generation DESC LIMIT 1
  ) THEN RAISE(ABORT, 'stale template release') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM templates t
    WHERE t.id = NEW.template_id
      AND ((NEW.source = 'system' AND t.origin = 'baked' AND t.org_id IS NEW.org_id
          AND t.status = 'active' AND t.active_version = NEW.version)
        OR (NEW.source = 'approved' AND t.origin = 'uploaded' AND NEW.org_id IS NOT NULL
          AND (t.org_id IS NULL OR t.org_id = NEW.org_id)
          AND (t.status = 'active' OR (t.status = 'archived' AND NEW.mode = 'live' AND t.org_id = NEW.org_id))))
  ) THEN RAISE(ABORT, 'invalid template release scope') END;
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
      AND r.provider = NEW.provider AND r.generation < NEW.generation - 1
      AND r.candidate_id = NEW.candidate_id AND r.approval_id = NEW.approval_id
      AND r.candidate_hash = NEW.candidate_hash AND r.version = NEW.version
  ) THEN RAISE(ABORT, 'invalid template rollback') END;
  SELECT CASE WHEN NEW.adapter_revision < COALESCE((
    SELECT r.adapter_revision FROM template_releases r
    WHERE r.template_id = NEW.template_id AND r.org_id IS NEW.org_id
      AND r.mode = NEW.mode AND r.provider = NEW.provider ORDER BY r.generation DESC LIMIT 1
  ), 0) OR NEW.audience_policy_revision < COALESCE((
    SELECT r.audience_policy_revision FROM template_releases r
    WHERE r.template_id = NEW.template_id AND r.org_id IS NEW.org_id
      AND r.mode = NEW.mode AND r.provider = NEW.provider ORDER BY r.generation DESC LIMIT 1
  ), 0) THEN RAISE(ABORT, 'stale template policy') END;
END;
CREATE TRIGGER template_releases_immutable BEFORE UPDATE ON template_releases
BEGIN SELECT RAISE(ABORT, 'template releases are immutable'); END;
CREATE TRIGGER template_releases_no_delete BEFORE DELETE ON template_releases
BEGIN SELECT RAISE(ABORT, 'template releases are immutable'); END;
-- REPLACE would recreate a release under an existing id and bypass the immutability guard.
CREATE TRIGGER template_releases_no_replace BEFORE INSERT ON template_releases
WHEN EXISTS (SELECT 1 FROM template_releases WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: template_releases.id'); END;

-- A pass keeps its issuing release; legacy rows remain NULL and cannot authorize new work.
ALTER TABLE passes ADD COLUMN release_id TEXT REFERENCES template_releases(id);
CREATE INDEX passes_release ON passes(release_id);

-- Mutable worker claims are scoped to the pass organization, even for a global baked release.
CREATE TABLE template_release_reissues (
  template_id TEXT NOT NULL REFERENCES templates(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'samsung')),
  release_id TEXT NOT NULL REFERENCES template_releases(id),
  PRIMARY KEY (template_id, org_id, mode, provider)
);
