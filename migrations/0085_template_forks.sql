-- Tracked copies of file-based templates: lineage, per-version bases and update offers.
-- A fork is an uploaded template plus one row here.

-- One row per fork. Upstream never changes.
CREATE TABLE template_forks (
  template_id TEXT PRIMARY KEY REFERENCES templates (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES templates (id),
  tracking TEXT NOT NULL DEFAULT 'on' CHECK (tracking IN ('on', 'paused')),
  tracking_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (upstream_id != template_id)
);
CREATE INDEX template_forks_upstream ON template_forks (upstream_id) WHERE tracking = 'on';
CREATE INDEX template_forks_org ON template_forks (org_id);
CREATE INDEX template_forks_tracking_by ON template_forks (tracking_by) WHERE tracking_by IS NOT NULL;
CREATE TRIGGER template_forks_fixed BEFORE UPDATE OF template_id, org_id, upstream_id ON template_forks
BEGIN SELECT RAISE(ABORT, 'template fork lineage is immutable'); END;
CREATE TRIGGER template_forks_insert BEFORE INSERT ON template_forks
WHEN NOT EXISTS (SELECT 1 FROM templates t WHERE t.id = NEW.template_id
  AND t.org_id = NEW.org_id AND t.origin = 'uploaded')
BEGIN SELECT RAISE(ABORT, 'invalid template fork'); END;

-- The upstream content a fork version incorporates. Write-once; a version may gain newer bases.
CREATE TABLE template_version_bases (
  template_id TEXT NOT NULL,
  version TEXT NOT NULL,
  upstream_id TEXT NOT NULL REFERENCES templates (id),
  upstream_version TEXT NOT NULL,
  upstream_content_hash TEXT CHECK (upstream_content_hash IS NULL OR (length(upstream_content_hash) = 64
    AND upstream_content_hash NOT GLOB '*[^0-9a-f]*')),
  via TEXT NOT NULL CHECK (via IN ('fork', 'edit', 'merge', 'resolve', 'noop', 'backfill')),
  parent_version TEXT,
  inferred INTEGER NOT NULL DEFAULT 0 CHECK (inferred IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, version, upstream_version),
  FOREIGN KEY (template_id, version) REFERENCES template_versions (template_id, version),
  FOREIGN KEY (upstream_id, upstream_version) REFERENCES template_versions (template_id, version)
) WITHOUT ROWID;
CREATE INDEX template_version_bases_upstream ON template_version_bases (upstream_id, upstream_version);
CREATE TRIGGER template_version_bases_immutable BEFORE UPDATE ON template_version_bases
BEGIN SELECT RAISE(ABORT, 'template version bases are immutable'); END;
CREATE TRIGGER template_version_bases_no_delete BEFORE DELETE ON template_version_bases
WHEN EXISTS (SELECT 1 FROM templates t WHERE t.id = OLD.template_id)
BEGIN SELECT RAISE(ABORT, 'template version bases are immutable'); END;
CREATE TRIGGER template_version_bases_insert BEFORE INSERT ON template_version_bases
WHEN NOT EXISTS (SELECT 1 FROM template_forks f WHERE f.template_id = NEW.template_id
  AND f.upstream_id = NEW.upstream_id)
BEGIN SELECT RAISE(ABORT, 'invalid template version base'); END;

-- One update offer per (fork, ours, upstream). Status is the job's or a dismissal's; accepted and
-- superseded are derived on read.
CREATE TABLE template_fork_updates (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES template_forks (template_id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  upstream_version TEXT NOT NULL,
  base_version TEXT,
  ours_version TEXT NOT NULL,
  merged_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'clean', 'conflicted', 'invalid', 'noop', 'failed', 'dismissed')),
  conflicts TEXT CHECK (conflicts IS NULL OR (json_valid(conflicts) AND json_type(conflicts) = 'array')),
  summary TEXT CHECK (summary IS NULL OR json_valid(summary)),
  engine_revision INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dismissed_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  UNIQUE (template_id, ours_version, upstream_version)
);
CREATE INDEX template_fork_updates_open ON template_fork_updates (org_id, status)
  WHERE status IN ('clean', 'conflicted', 'invalid');
CREATE INDEX template_fork_updates_dismissed_by ON template_fork_updates (dismissed_by)
  WHERE dismissed_by IS NOT NULL;
CREATE TRIGGER template_fork_updates_fixed BEFORE UPDATE OF id, template_id, org_id, upstream_id,
  upstream_version, base_version, ours_version, created_at ON template_fork_updates
BEGIN SELECT RAISE(ABORT, 'template fork update identity is immutable'); END;
-- A terminal row stays terminal except dismissal of an open offer.
CREATE TRIGGER template_fork_updates_status BEFORE UPDATE OF status ON template_fork_updates
WHEN NOT (OLD.status IN ('pending', 'failed')
  OR (OLD.status IN ('clean', 'conflicted', 'invalid') AND NEW.status = 'dismissed'))
BEGIN SELECT RAISE(ABORT, 'template fork update is settled'); END;
