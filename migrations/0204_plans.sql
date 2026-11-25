-- Plans: Starter and Premium join Trial, Standard and Unlimited (the `legacy` id, relabelled). Their rows are
-- literal, one per registry key, and a test holds them equal to the registry. A fixed time, and no preset
-- revision is bumped: with the preset editor's `preset_revision`, a higher revision would mark every org
-- on the preset as pending and the next edit would move them from nothing.
INSERT INTO entitlement_preset_meta (preset, label, is_plan, revision, updated_at) VALUES
  ('starter', 'Starter', 1, 1, 1795392000000),
  ('premium', 'Premium', 1, 1, 1795392000000);

INSERT INTO entitlement_presets (preset, key, value) VALUES
  ('starter', 'api', '"full"'),
  ('starter', 'api.rateTier', '"standard"'),
  ('starter', 'api.keys', '3'),
  ('starter', 'apps', '0'),
  ('starter', 'webhooks', '1'),
  ('starter', 'webhooks.endpoints', '2'),
  ('starter', 'connections', '2'),
  ('starter', 'connectors', '["csv-url","webhook-push/*"]'),
  ('starter', 'wallet.google', '1'),
  ('starter', 'wallet.samsung', '0'),
  ('starter', 'print', '1'),
  ('starter', 'nfc', '"off"'),
  ('starter', 'scanning.devices', '5'),
  ('starter', 'join.perDay', '250'),
  ('starter', 'messages.perDay', '5'),
  ('starter', 'passes.changesPerDay', '5'),
  ('starter', 'passes.live', '1000'),
  ('starter', 'passes.test', '200'),
  ('starter', 'templates', '5'),
  ('starter', 'templates.uploads', '0'),
  ('starter', 'templates.stylesBlocked', '["boardingPass"]'),
  ('starter', 'email.perDay', '250'),
  ('starter', 'members', '5'),
  ('starter', 'brand.mark', '"full"'),
  ('starter', 'domains', '0'),
  ('starter', 'identity.own', '0'),
  ('starter', 'identity.managed', '0'),
  ('premium', 'api', '"full"'),
  ('premium', 'api.rateTier', '"bulk"'),
  ('premium', 'api.keys', '50'),
  ('premium', 'apps', '1'),
  ('premium', 'webhooks', '1'),
  ('premium', 'webhooks.endpoints', '50'),
  ('premium', 'connections', '50'),
  ('premium', 'connectors', '["*"]'),
  ('premium', 'wallet.google', '1'),
  ('premium', 'wallet.samsung', '1'),
  ('premium', 'print', '1'),
  ('premium', 'nfc', '"secure"'),
  ('premium', 'scanning.devices', '100'),
  ('premium', 'join.perDay', '10000'),
  ('premium', 'messages.perDay', '100'),
  ('premium', 'passes.changesPerDay', '100'),
  ('premium', 'passes.live', '50000'),
  ('premium', 'passes.test', '2000'),
  ('premium', 'templates', '100'),
  ('premium', 'templates.uploads', '1'),
  ('premium', 'templates.stylesBlocked', '[]'),
  ('premium', 'email.perDay', '5000'),
  ('premium', 'members', '100'),
  ('premium', 'brand.mark', '"none"'),
  ('premium', 'domains', '5'),
  ('premium', 'identity.own', '1'),
  ('premium', 'identity.managed', '1');

UPDATE entitlement_preset_meta SET label = 'Unlimited', updated_at = 1795392000000 WHERE preset = 'legacy';
UPDATE entitlement_preset_meta SET is_plan = 1 WHERE preset IN ('trial', 'standard', 'legacy');

-- Unlimited only gains: the footer can be off, custom domains have no cap (not built yet).
UPDATE entitlement_presets SET value = '"none"' WHERE preset = 'legacy' AND key = 'brand.mark';
UPDATE entitlement_presets SET value = 'null' WHERE preset = 'legacy' AND key = 'domains';

-- An org whose effective footer allowance is `full` (its plan's, or a standing override's, read at the fixed
-- time below) but whose stored choice is the small one keeps it, so enforcing `brand.mark` takes nothing away.
-- The org's override is set to `quiet`: an existing one (a standing `full`, or an expired one) is replaced, never
-- skipped. Unlimited (`legacy`) orgs are never written to. The revision bump makes a Features tab opened before this 409.
INSERT INTO org_entitlement_overrides (org_id, key, value, note, expires_at, updated_at, updated_by)
  SELECT e.org_id, 'brand.mark', '"quiet"', 'Kept the small footer when plans changed', NULL, 1795392000000, NULL
  FROM org_entitlements e
  JOIN orgs o ON o.id = e.org_id
  JOIN entitlement_presets p ON p.preset = e.preset AND p.key = 'brand.mark'
  WHERE e.preset <> 'legacy'
    AND json_valid(o.branding) AND json_extract(o.branding, '$.mark') = 'small'
    AND COALESCE(
      (SELECT x.value FROM org_entitlement_overrides x
        WHERE x.org_id = e.org_id AND x.key = 'brand.mark' AND (x.expires_at IS NULL OR x.expires_at > 1795392000000)),
      p.value) = '"full"'
  ON CONFLICT (org_id, key) DO UPDATE SET
    value = excluded.value, note = excluded.note, expires_at = NULL,
    updated_at = excluded.updated_at, updated_by = NULL;
UPDATE org_entitlements SET revision = revision + 1, updated_at = 1795392000000
  WHERE org_id IN (
    SELECT org_id FROM org_entitlement_overrides
    WHERE key = 'brand.mark' AND updated_at = 1795392000000 AND note = 'Kept the small footer when plans changed'
  );
