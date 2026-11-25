-- Trial and Starter may also use File upload and Demo (the connector allow-list is now enforced at create).
-- Done the way the preset editor does it: `previous_values` is the preset as it stood, the revision moves up, and
-- each org that was aligned to the old revision moves with it (its own revision bumps so an open Features tab
-- 409s). Orgs hold no copy of preset values, so their overrides are untouched; an org still waiting on an
-- earlier edit stays behind. A fixed time, no audit rows and no channel runs: only a connector list grows.
UPDATE org_entitlements SET
  preset_revision = (SELECT m.revision + 1 FROM entitlement_preset_meta m WHERE m.preset = org_entitlements.preset),
  revision = revision + 1,
  updated_at = 1795478400000
WHERE preset IN ('trial', 'starter')
  AND preset_revision = (SELECT m.revision FROM entitlement_preset_meta m WHERE m.preset = org_entitlements.preset);

UPDATE entitlement_preset_meta SET
  previous_values = (
    SELECT json_group_object(p.key, json(p.value)) FROM entitlement_presets p WHERE p.preset = entitlement_preset_meta.preset),
  revision = revision + 1,
  updated_at = 1795478400000
WHERE preset IN ('trial', 'starter');

UPDATE entitlement_presets SET value = '["csv-url","webhook-push/*","file-upload","demo"]'
WHERE preset IN ('trial', 'starter') AND key = 'connectors';
