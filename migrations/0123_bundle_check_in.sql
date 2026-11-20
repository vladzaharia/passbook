-- Bundle check-in: the scans one group request made, so one undo reverses them all.
CREATE TABLE scan_group_members (
  group_scan_id TEXT NOT NULL REFERENCES scans (id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL REFERENCES scans (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  PRIMARY KEY (group_scan_id, scan_id)
);
CREATE INDEX scan_group_members_scan ON scan_group_members (scan_id);
