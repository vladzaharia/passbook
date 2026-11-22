-- A door's reconnect grace. When a request arrives after a silence, the server keeps the last contact before it
-- (contact_prev_at) and when the new stretch began (online_since); a batch inside the grace of that is judged
-- against the pre-gap contact, so polls, sign-in or a refused sync before the upload do not re-date honest reads.
ALTER TABLE scanners ADD COLUMN contact_prev_at INTEGER;
ALTER TABLE scanners ADD COLUMN online_since INTEGER;
