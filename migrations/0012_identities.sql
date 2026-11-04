-- APNs token auth: one .p8 push key per Apple team, envelope-encrypted (AAD = id|team|apns_key).

CREATE TABLE apns_keys (
  id TEXT PRIMARY KEY,
  team_identifier TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX apns_keys_created_by ON apns_keys (created_by);
