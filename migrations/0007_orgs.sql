-- Set when a pass-affecting branding change is saved; a minute cron reissues the org's passes
-- once it has been quiet, so a run of edits becomes one reissue.
ALTER TABLE orgs ADD COLUMN branding_dirty_at INTEGER;
CREATE INDEX orgs_branding_dirty ON orgs (branding_dirty_at) WHERE branding_dirty_at IS NOT NULL;
