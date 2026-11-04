-- The active version whose live passes the minute cron last queued for a rebuild. A template whose
-- active_version differs gets its stale passes reissued once it has been quiet for a minute.
ALTER TABLE templates ADD COLUMN reissued_version TEXT;
