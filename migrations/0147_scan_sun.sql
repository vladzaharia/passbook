-- A Secure tap that opened a scan keeps the counter it used. A follow-up of that scan (a confirm, Let in again,
-- an override) on the same device may present the same read once: `sun_followup_at` marks it used.
ALTER TABLE scans ADD COLUMN sun_ctr INTEGER;
ALTER TABLE scans ADD COLUMN sun_key_version INTEGER;
ALTER TABLE scans ADD COLUMN sun_followup_at INTEGER;
CREATE INDEX scans_sun_followup ON scans (tag_id, sun_ctr) WHERE sun_ctr IS NOT NULL;
