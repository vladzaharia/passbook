-- `identity.managed`: hosted Pass Type IDs. Every preset takes the value of `identity.own` (on in legacy and
-- standard, off in trial); the registry in src/shared/contracts/entitlements.ts holds the same.
INSERT INTO entitlement_presets (preset, key, value)
  SELECT preset, 'identity.managed', value FROM entitlement_presets WHERE key = 'identity.own';
