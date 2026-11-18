-- Exact-match lookup and the per-template uniqueness check by external id.
CREATE INDEX passes_org_template_external ON passes (org_id, template_id, external_id)
  WHERE external_id IS NOT NULL;
