-- A download link is single use: the latest link's expiry, and when it was spent.
ALTER TABLE org_exports ADD COLUMN link_exp INTEGER;
ALTER TABLE org_exports ADD COLUMN link_used_at INTEGER;
