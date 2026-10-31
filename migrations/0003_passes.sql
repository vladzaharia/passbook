-- Keyset pagination of the admin pass list (newest first, optionally per org).
CREATE INDEX passes_org_id ON passes (org_id, id DESC);
