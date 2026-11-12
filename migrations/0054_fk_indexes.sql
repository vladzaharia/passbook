-- Child-side indexes for foreign keys added without one, so parent deletes and joins don't scan.
CREATE INDEX template_candidates_version_fk ON template_candidates(template_id, version);
CREATE INDEX template_candidates_org_fk ON template_candidates(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX template_releases_version_fk ON template_releases(template_id, version);
CREATE INDEX template_releases_rollback_fk ON template_releases(rollback_of_release_id)
  WHERE rollback_of_release_id IS NOT NULL;
CREATE INDEX template_releases_previous_fk ON template_releases(previous_release_id)
  WHERE previous_release_id IS NOT NULL;
CREATE INDEX template_releases_approval_fk ON template_releases(approval_id)
  WHERE approval_id IS NOT NULL;
CREATE INDEX template_releases_org_fk ON template_releases(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX template_release_reissues_release_fk ON template_release_reissues(release_id);
CREATE INDEX template_release_reissues_org_fk ON template_release_reissues(org_id);
CREATE INDEX workflow_release_snapshots_release_fk ON workflow_release_snapshots(release_id);
CREATE INDEX scan_asset_grant_provenance_org_fk ON scan_asset_grant_provenance(org_id);
