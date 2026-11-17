-- Partial indexes for three scans over passes: the holder-reattach sweep, the quiet-template
-- sweep (distinct active scopes) and the scanner's expected count.
CREATE INDEX passes_waiting_holder ON passes(id)
  WHERE holder_email IS NOT NULL AND owner_user_id IS NULL AND deleted_at IS NULL
    AND test_data_quarantined = 0;
CREATE INDEX passes_active_scope ON passes(template_id, org_id, mode)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX passes_scan_population ON passes(org_id, mode, template_id)
  WHERE deleted_at IS NULL AND removed_at IS NULL AND status = 'active'
    AND test_data_quarantined = 0;
