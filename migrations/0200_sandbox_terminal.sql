-- A sandbox's own terminal (its key scans as it, in Test): matched by id, not by display name.
ALTER TABLE developer_sandboxes ADD COLUMN terminal_id TEXT;
UPDATE developer_sandboxes SET terminal_id = (
  SELECT s.id FROM scanners s
  WHERE s.org_id = developer_sandboxes.org_id AND s.mode = 'test' AND s.kind = 'terminal'
    AND s.name = 'Sandbox terminal' AND s.revoked_at IS NULL);
