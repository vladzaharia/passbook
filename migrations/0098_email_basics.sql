-- Reply-to confirmation: an org's support address is used as reply-to only after its owner follows a link.
-- The token is stored hashed and cleared on use; one row per org.

CREATE TABLE org_reply_to (
  org_id TEXT PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  token_hash TEXT,
  expires_at INTEGER,
  sent_at INTEGER,
  confirmed_at INTEGER,
  CHECK ((token_hash IS NULL) = (expires_at IS NULL))
);
