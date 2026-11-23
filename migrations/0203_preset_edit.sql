-- Editing a preset moves every org on it (docs/operations.md, plan changes). `preset_revision` is the preset
-- revision an org's features were last aligned to: an org below its preset's revision is still being moved.
-- `previous_values` is the preset as it stood before the last edit, so a move that stops part-way resumes
-- with the same before/after.
ALTER TABLE entitlement_preset_meta ADD COLUMN previous_values TEXT
  CHECK (previous_values IS NULL OR json_valid(previous_values));
ALTER TABLE org_entitlements ADD COLUMN preset_revision INTEGER NOT NULL DEFAULT 0;
UPDATE org_entitlements SET preset_revision = COALESCE(
  (SELECT m.revision FROM entitlement_preset_meta m WHERE m.preset = org_entitlements.preset), 1);
-- A new org starts aligned to its preset.
CREATE TRIGGER org_entitlements_aligned AFTER INSERT ON org_entitlements
WHEN NEW.preset_revision = 0
BEGIN
  UPDATE org_entitlements SET preset_revision =
    (SELECT m.revision FROM entitlement_preset_meta m WHERE m.preset = NEW.preset)
  WHERE org_id = NEW.org_id;
END;
