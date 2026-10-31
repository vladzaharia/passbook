-- Wallet personalization (rewards enrollment): holder info sent by Wallet, encrypted per row.
-- A row marks the pass as personalized: the pass is then built without personalization.json.
CREATE TABLE pass_personalizations (
  pass_id TEXT PRIMARY KEY REFERENCES passes (id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);
