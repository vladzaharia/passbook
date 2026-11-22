-- A developer sandbox may create 10 change runs in 24 hours (it was 0, so a sandbox could never run one).
INSERT OR REPLACE INTO entitlement_presets (preset, key, value) VALUES ('developer', 'passes.changesPerDay', '10');
UPDATE entitlement_preset_meta SET updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE preset = 'developer';
