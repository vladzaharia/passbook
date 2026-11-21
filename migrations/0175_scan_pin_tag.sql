-- A PIN's org-scoped tag, HMAC(K_pin_tag, org_id:pin): one active person per PIN, and an indexed PIN-only sign-in.
-- Null on rows from before this; the next verified sign-in fills it. A conflict there means a shared PIN.
ALTER TABLE scan_staff ADD COLUMN pin_tag TEXT;
-- Set when a shared PIN is seen: sign-in is refused until an admin resets it, which clears it.
ALTER TABLE scan_staff ADD COLUMN pin_reset_required INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX scan_staff_org_pin_tag ON scan_staff (org_id, pin_tag) WHERE disabled_at IS NULL AND pin_tag IS NOT NULL;

-- An offline read dated before the door's last contact or its list is recorded at server time and marked late.
ALTER TABLE scan_offline_reads ADD COLUMN late INTEGER NOT NULL DEFAULT 0;
