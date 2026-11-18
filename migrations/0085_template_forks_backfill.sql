-- Lineage for templates made before forks were tracked. Revertable alone: it only inserts rows.

-- Use blueprint: the copy names its blueprint. The base version is inferred lazily by the merge job.
INSERT INTO template_forks (template_id, org_id, upstream_id, tracking, tracking_by, created_at, updated_at)
SELECT t.id, t.org_id, t.source_blueprint, 'on', NULL, t.created_at, t.created_at
FROM templates t
WHERE t.source_blueprint IS NOT NULL AND t.origin = 'uploaded' AND t.org_id IS NOT NULL
  AND t.source_blueprint != t.id
  AND NOT EXISTS (SELECT 1 FROM template_forks f WHERE f.template_id = t.id)
  AND EXISTS (SELECT 1 FROM templates u WHERE u.id = t.source_blueprint);

-- Duplicate of a baked built-in: the audit row names the exact source version.
INSERT INTO template_forks (template_id, org_id, upstream_id, tracking, tracking_by, created_at, updated_at)
SELECT t.id, t.org_id, json_extract(a.detail, '$.sourceId'), 'on', NULL, t.created_at, t.created_at
FROM templates t
JOIN audit_log a ON a.id = (
  SELECT MIN(c.id) FROM audit_log c
  WHERE c.action = 'template.clone' AND c.target_type = 'template' AND c.target_id = t.id
    AND c.org_id = t.org_id AND json_valid(c.detail)
    AND json_extract(c.detail, '$.sourceId') LIKE 'baked:%')
WHERE t.origin = 'uploaded' AND t.org_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM template_forks f WHERE f.template_id = t.id)
  AND EXISTS (SELECT 1 FROM templates u WHERE u.id = json_extract(a.detail, '$.sourceId'));

-- Their first version incorporates the recorded source version, when that version still exists.
-- An exact Use blueprint audited it too; a draft copy records no source version and stays estimated.
INSERT INTO template_version_bases
  (template_id, version, upstream_id, upstream_version, upstream_content_hash, via, parent_version, inferred, created_at)
SELECT f.template_id, v.version, f.upstream_id, json_extract(a.detail, '$.sourceVersion'),
  (SELECT h.content_hash FROM template_version_hashes h
   WHERE h.template_id = f.upstream_id AND h.version = json_extract(a.detail, '$.sourceVersion')),
  'backfill', NULL, 0, v.created_at
FROM template_forks f
JOIN audit_log a ON a.id = (
  SELECT MIN(c.id) FROM audit_log c
  WHERE c.action IN ('template.clone', 'template.use_blueprint') AND c.target_type = 'template'
    AND c.target_id = f.template_id AND c.org_id = f.org_id AND json_valid(c.detail)
    AND json_extract(c.detail, '$.sourceId') = f.upstream_id
    AND json_extract(c.detail, '$.sourceVersion') IS NOT NULL)
JOIN template_versions v ON v.template_id = f.template_id AND v.version = (
  SELECT v1.version FROM template_versions v1 WHERE v1.template_id = f.template_id
  ORDER BY v1.created_at, v1.version LIMIT 1)
WHERE EXISTS (SELECT 1 FROM template_versions u WHERE u.template_id = f.upstream_id
  AND u.version = json_extract(a.detail, '$.sourceVersion'))
  AND NOT EXISTS (SELECT 1 FROM template_version_bases b WHERE b.template_id = f.template_id);
