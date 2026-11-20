-- Limits on every create path (design-multi-tenancy.md MT5). The pass limits count the passes an org
-- holds in a mode: a partial index answers that without reading the rows.
CREATE INDEX passes_org_mode_held ON passes (org_id, mode)
  WHERE removed_at IS NULL AND deleted_at IS NULL AND test_data_quarantined = 0;

-- Rows of a pass import skipped because the plan's pass limit was reached.
ALTER TABLE pass_imports ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
