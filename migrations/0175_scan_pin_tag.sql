-- A PIN's org-scoped tag, HMAC(K_pin_tag, org_id:pin): one active person per PIN, and an indexed PIN-only sign-in.
-- Null on rows from before this; the next verified sign-in fills it. A conflict there means a shared PIN.
ALTER TABLE scan_staff ADD COLUMN pin_tag TEXT;
-- Set when a shared PIN is seen: the person signs in, then the server sets a new PIN for them (a clear flag ends it).
ALTER TABLE scan_staff ADD COLUMN pin_reset_required INTEGER NOT NULL DEFAULT 0;
-- When the server issued the new PIN, on which sign-in (scanner id : staff_since) and how often again: one repeat inside 10 minutes.
ALTER TABLE scan_staff ADD COLUMN pin_issued_at INTEGER;
ALTER TABLE scan_staff ADD COLUMN pin_issued_binding TEXT;
ALTER TABLE scan_staff ADD COLUMN pin_issue_repeats INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX scan_staff_org_pin_tag ON scan_staff (org_id, pin_tag) WHERE disabled_at IS NULL AND pin_tag IS NOT NULL;

-- An offline read dated before the door's last contact or its list is recorded at server time and marked late.
ALTER TABLE scan_offline_reads ADD COLUMN late INTEGER NOT NULL DEFAULT 0;
CREATE INDEX scan_offline_reads_late ON scan_offline_reads (scan_id) WHERE late = 1;
-- The door's last request that was not an upload, stamped by the server: the floor for a queued read.
ALTER TABLE scanners ADD COLUMN contact_at INTEGER;
-- When the door last downloaded its list: the floor for a listed read, kept by the server.
ALTER TABLE scan_offline_state ADD COLUMN roster_at INTEGER NOT NULL DEFAULT 0;
