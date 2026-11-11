-- Capture the effective Apple release for each tenant, mode, and template at workflow reservation.
-- Subsequent pages must use these snapshots rather than adopting a newer release.
CREATE TABLE workflow_release_snapshot_sets (
  instance_id TEXT NOT NULL PRIMARY KEY REFERENCES workflow_runs (instance_id) ON DELETE CASCADE
);

CREATE TABLE workflow_release_snapshots (
  instance_id TEXT NOT NULL REFERENCES workflow_release_snapshot_sets (instance_id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  template_id TEXT NOT NULL,
  release_id TEXT NOT NULL REFERENCES template_releases (id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  version TEXT NOT NULL,
  PRIMARY KEY (instance_id, org_id, mode, template_id)
);
CREATE TRIGGER workflow_release_snapshot_sets_immutable
BEFORE UPDATE ON workflow_release_snapshot_sets
BEGIN
  SELECT RAISE(ABORT, 'workflow release snapshot sets are immutable');
END;


CREATE TRIGGER workflow_release_snapshots_immutable
BEFORE UPDATE ON workflow_release_snapshots
BEGIN
  SELECT RAISE(ABORT, 'workflow release snapshots are immutable');
END;
