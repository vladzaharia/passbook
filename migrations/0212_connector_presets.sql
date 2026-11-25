-- Trial and Starter may also use File upload and Demo (the connector allow-list is now enforced at create).
-- Done the way the preset editor does it, and only where the list names neither a `*` nor both items already:
-- `previous_values` is the preset as it stood, the revision moves up, and each org that was aligned to the old
-- revision moves with it (its own revision bumps so an open Features tab 409s). Orgs hold no copy of preset
-- values, so their overrides are untouched, except that a `connectors` override listing every item of the old
-- preset (a superset) gains the two items too, so those orgs keep Demo. An org still waiting on an earlier edit
-- stays behind and becomes a gap org on its next move (the designed safe path: a full re-evaluation). A fixed
-- time, no audit rows and no channel runs: only a connector list grows.
UPDATE org_entitlements SET
  preset_revision = (SELECT m.revision + 1 FROM entitlement_preset_meta m WHERE m.preset = org_entitlements.preset),
  revision = revision + 1,
  updated_at = MAX(updated_at, 1795478400000),
  updated_by = NULL
WHERE preset IN ('trial', 'starter')
  AND preset_revision = (SELECT m.revision FROM entitlement_preset_meta m WHERE m.preset = org_entitlements.preset)
  AND EXISTS (SELECT 1 FROM entitlement_presets p WHERE p.preset = org_entitlements.preset AND p.key = 'connectors'
    AND json_type(p.value) = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = '*')
    AND (NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = 'file-upload')
      OR NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = 'demo')));

UPDATE org_entitlement_overrides SET
  value = CASE WHEN EXISTS (SELECT 1 FROM json_each(CASE WHEN EXISTS (SELECT 1 FROM json_each(org_entitlement_overrides.value) j WHERE j.value = 'file-upload') THEN org_entitlement_overrides.value ELSE json_insert(org_entitlement_overrides.value, '$[#]', 'file-upload') END) j WHERE j.value = 'demo')
    THEN CASE WHEN EXISTS (SELECT 1 FROM json_each(org_entitlement_overrides.value) j WHERE j.value = 'file-upload') THEN org_entitlement_overrides.value ELSE json_insert(org_entitlement_overrides.value, '$[#]', 'file-upload') END
    ELSE json_insert(CASE WHEN EXISTS (SELECT 1 FROM json_each(org_entitlement_overrides.value) j WHERE j.value = 'file-upload') THEN org_entitlement_overrides.value ELSE json_insert(org_entitlement_overrides.value, '$[#]', 'file-upload') END, '$[#]', 'demo') END,
  updated_at = MAX(updated_at, 1795478400000),
  updated_by = NULL
WHERE key = 'connectors'
  AND json_valid(value) AND json_type(value) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(org_entitlement_overrides.value) j WHERE j.value = '*')
  AND EXISTS (SELECT 1 FROM org_entitlements e WHERE e.org_id = org_entitlement_overrides.org_id AND e.preset IN ('trial', 'starter')
    AND EXISTS (SELECT 1 FROM entitlement_presets p WHERE p.preset = e.preset AND p.key = 'connectors'
    AND json_type(p.value) = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = '*')
    AND (NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = 'file-upload')
      OR NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = 'demo')))
    AND NOT EXISTS (
      SELECT 1 FROM entitlement_presets p, json_each(p.value) old
      WHERE p.preset = e.preset AND p.key = 'connectors'
        AND NOT EXISTS (SELECT 1 FROM json_each(org_entitlement_overrides.value) o WHERE o.value = old.value)));

UPDATE entitlement_preset_meta SET
  previous_values = (
    SELECT json_group_object(p.key, json(p.value)) FROM entitlement_presets p WHERE p.preset = entitlement_preset_meta.preset),
  revision = revision + 1,
  updated_at = MAX(updated_at, 1795478400000),
  updated_by = NULL
WHERE preset IN ('trial', 'starter')
  AND EXISTS (SELECT 1 FROM entitlement_presets p WHERE p.preset = entitlement_preset_meta.preset AND p.key = 'connectors'
    AND json_type(p.value) = 'array'
    AND NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = '*')
    AND (NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = 'file-upload')
      OR NOT EXISTS (SELECT 1 FROM json_each(p.value) j WHERE j.value = 'demo')));

UPDATE entitlement_presets SET value = CASE WHEN EXISTS (SELECT 1 FROM json_each(CASE WHEN EXISTS (SELECT 1 FROM json_each(entitlement_presets.value) j WHERE j.value = 'file-upload') THEN entitlement_presets.value ELSE json_insert(entitlement_presets.value, '$[#]', 'file-upload') END) j WHERE j.value = 'demo')
    THEN CASE WHEN EXISTS (SELECT 1 FROM json_each(entitlement_presets.value) j WHERE j.value = 'file-upload') THEN entitlement_presets.value ELSE json_insert(entitlement_presets.value, '$[#]', 'file-upload') END
    ELSE json_insert(CASE WHEN EXISTS (SELECT 1 FROM json_each(entitlement_presets.value) j WHERE j.value = 'file-upload') THEN entitlement_presets.value ELSE json_insert(entitlement_presets.value, '$[#]', 'file-upload') END, '$[#]', 'demo') END
WHERE preset IN ('trial', 'starter') AND key = 'connectors'
  AND json_type(value) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(entitlement_presets.value) j WHERE j.value = '*')
  AND (NOT EXISTS (SELECT 1 FROM json_each(entitlement_presets.value) j WHERE j.value = 'file-upload')
    OR NOT EXISTS (SELECT 1 FROM json_each(entitlement_presets.value) j WHERE j.value = 'demo'));
