-- A developer sandbox may start 10 change runs a day (it was 0, so a sandbox could never run one).
INSERT OR REPLACE INTO entitlement_presets (preset, key, value) VALUES ('developer', 'passes.changesPerDay', '10');
UPDATE entitlement_preset_meta SET revision = revision + 1 WHERE preset = 'developer';
