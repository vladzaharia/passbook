-- Pocket ID identity awaiting email proof (oidc.trustEmail off); linked when the link is consumed.
ALTER TABLE magic_links ADD COLUMN pending_identity TEXT CHECK (pending_identity IS NULL OR json_valid(pending_identity));
