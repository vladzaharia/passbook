-- Secure tags (design-nfc-tag-systems.md 3.3, S2): keysets per org and mode, their versioned keys, and the
-- per-tag side row that holds a SUN tag's counter. Key material is envelope-encrypted by the Worker in the
-- four standard columns (kek_version, iv, wrapped_dek, ciphertext; platform/crypto.ts), AAD bound to org, mode,
-- keyset and version (or tag); the database only sees ciphertext. Both tables are places of cron keys.rewrap
-- (modules/keys/rewrap-tables.ts): only kek_version and wrapped_dek ever change, and only upward.

CREATE TABLE nfc_tag_keysets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) = 8 AND slug NOT GLOB '*[^a-z0-9]*'),
  diversify INTEGER NOT NULL CHECK (diversify IN (0, 1)),
  -- The type tags enrolled on this keyset get by default.
  type_id TEXT REFERENCES nfc_tag_types (id),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  disabled_at INTEGER
);
CREATE INDEX nfc_tag_keysets_org ON nfc_tag_keysets (org_id, mode, id);
CREATE INDEX nfc_tag_keysets_type ON nfc_tag_keysets (type_id) WHERE type_id IS NOT NULL;

CREATE TABLE nfc_tag_keys (
  id TEXT PRIMARY KEY,
  keyset_id TEXT NOT NULL REFERENCES nfc_tag_keysets (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 255),
  -- One envelope holds the meta key and the file key (32 bytes). The file key is the master when the keyset
  -- diversifies. 12-byte iv, 32 + 16 bytes of ciphertext, a DEK wrapped by the KEK (12 + 32 + 16).
  kek_version INTEGER NOT NULL CHECK (kek_version >= 1),
  iv BLOB NOT NULL CHECK (length(iv) = 12),
  wrapped_dek BLOB NOT NULL CHECK (length(wrapped_dek) = 60),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) = 48),
  state TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'retired')),
  created_at INTEGER NOT NULL,
  state_at INTEGER,
  UNIQUE (keyset_id, version)
);
CREATE UNIQUE INDEX nfc_tag_keys_active ON nfc_tag_keys (keyset_id) WHERE state = 'active';
-- A read is decrypted with the active key, then the retiring one: at most two tries.
CREATE UNIQUE INDEX nfc_tag_keys_retiring ON nfc_tag_keys (keyset_id) WHERE state = 'retiring';

CREATE TABLE nfc_tag_sun (
  tag_id TEXT PRIMARY KEY REFERENCES nfc_tags (id) ON DELETE CASCADE,
  keyset_id TEXT NOT NULL REFERENCES nfc_tag_keysets (id),
  key_version INTEGER NOT NULL CHECK (key_version BETWEEN 1 AND 255),
  -- A supplier's per-tag file key (16 bytes), sealed; all four NULL means the keyset's.
  kek_version INTEGER,
  iv BLOB,
  wrapped_dek BLOB,
  ciphertext BLOB,
  ctr INTEGER NOT NULL CHECK (ctr BETWEEN 0 AND 16777215),
  ctr_at INTEGER NOT NULL,
  FOREIGN KEY (keyset_id, key_version) REFERENCES nfc_tag_keys (keyset_id, version),
  CHECK ((kek_version IS NULL AND iv IS NULL AND wrapped_dek IS NULL AND ciphertext IS NULL)
    OR (kek_version IS NOT NULL AND iv IS NOT NULL AND wrapped_dek IS NOT NULL AND ciphertext IS NOT NULL
      AND kek_version >= 1 AND length(iv) = 12 AND length(wrapped_dek) = 60 AND length(ciphertext) = 32))
);
CREATE INDEX nfc_tag_sun_keyset ON nfc_tag_sun (keyset_id, key_version);

-- Keysets: four live ones per org and mode; org, mode, slug and creation never change; a disabled keyset stays
-- disabled (compromise is answered with a new keyset, never by turning an old one back on).
CREATE TRIGGER nfc_tag_keysets_insert BEFORE INSERT ON nfc_tag_keysets
BEGIN
  SELECT RAISE(ABORT, 'keyset_disabled') WHERE NEW.disabled_at IS NOT NULL;
  SELECT RAISE(ABORT, 'keyset_limit') WHERE (SELECT count(*) FROM nfc_tag_keysets k
    WHERE k.org_id = NEW.org_id AND k.mode = NEW.mode AND k.disabled_at IS NULL) >= 4;
  SELECT RAISE(ABORT, 'keyset_type_tenant') WHERE NEW.type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.org_id = NEW.org_id AND y.system = 'sun');
END;
CREATE TRIGGER nfc_tag_keysets_fixed BEFORE UPDATE OF id, org_id, mode, slug, diversify, created_at, created_by
  ON nfc_tag_keysets
BEGIN SELECT RAISE(ABORT, 'keyset_fixed'); END;
CREATE TRIGGER nfc_tag_keysets_update BEFORE UPDATE ON nfc_tag_keysets
BEGIN
  SELECT RAISE(ABORT, 'keyset_disabled') WHERE OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NOT OLD.disabled_at;
  SELECT RAISE(ABORT, 'keyset_type_tenant') WHERE NEW.type_id IS NOT NULL AND NEW.type_id IS NOT OLD.type_id
    AND NOT EXISTS (SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.org_id = NEW.org_id AND y.system = 'sun');
END;

-- Keys: versions count up one at a time on a live keyset, a new one is active, and a key only moves forward:
-- active, retiring, retired. Retiring is refused while a tag still uses the version (a disabled keyset retires
-- everything). The envelope never changes but for a rewrap: a higher kek_version with a new wrapped_dek, together.
CREATE TRIGGER nfc_tag_keys_insert BEFORE INSERT ON nfc_tag_keys
BEGIN
  SELECT RAISE(ABORT, 'tag_key_state') WHERE NEW.state <> 'active';
  SELECT RAISE(ABORT, 'keyset_disabled') WHERE EXISTS (
    SELECT 1 FROM nfc_tag_keysets k WHERE k.id = NEW.keyset_id AND k.disabled_at IS NOT NULL);
  SELECT RAISE(ABORT, 'tag_key_version') WHERE NEW.version <>
    coalesce((SELECT max(version) FROM nfc_tag_keys k WHERE k.keyset_id = NEW.keyset_id), 0) + 1;
END;
CREATE TRIGGER nfc_tag_keys_update BEFORE UPDATE ON nfc_tag_keys
BEGIN
  SELECT RAISE(ABORT, 'tag_key_fixed') WHERE NEW.id IS NOT OLD.id OR NEW.keyset_id IS NOT OLD.keyset_id
    OR NEW.version IS NOT OLD.version OR NEW.created_at IS NOT OLD.created_at
    OR NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
    OR ((NEW.kek_version IS NOT OLD.kek_version OR NEW.wrapped_dek IS NOT OLD.wrapped_dek)
      AND NOT (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek));
  SELECT RAISE(ABORT, 'tag_key_state') WHERE NOT (NEW.state = OLD.state
    OR (OLD.state = 'active' AND NEW.state = 'retiring')
    OR (OLD.state = 'retiring' AND NEW.state = 'retired')
    OR (OLD.state = 'active' AND NEW.state = 'retired' AND EXISTS (
      SELECT 1 FROM nfc_tag_keysets k WHERE k.id = OLD.keyset_id AND k.disabled_at IS NOT NULL)));
  SELECT RAISE(ABORT, 'tag_key_in_use') WHERE NEW.state = 'retired' AND OLD.state <> 'retired'
    AND EXISTS (SELECT 1 FROM nfc_tag_sun s WHERE s.keyset_id = OLD.keyset_id AND s.key_version = OLD.version)
    AND NOT EXISTS (SELECT 1 FROM nfc_tag_keysets k WHERE k.id = OLD.keyset_id AND k.disabled_at IS NOT NULL);
END;
CREATE TRIGGER nfc_tag_keys_no_delete BEFORE DELETE ON nfc_tag_keys
WHEN EXISTS (SELECT 1 FROM nfc_tag_keysets k WHERE k.id = OLD.keyset_id)
BEGIN SELECT RAISE(ABORT, 'tag_key_fixed'); END;

-- Side rows: a `sun` tag of the keyset's org and mode, on a live keyset and a key that has not been retired.
-- The counter never goes back, the keyset never changes, the key version only rises and a per-tag key never
-- changes (a rewrap aside).
CREATE TRIGGER nfc_tag_sun_insert BEFORE INSERT ON nfc_tag_sun
BEGIN
  SELECT RAISE(ABORT, 'tag_sun_tenant') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tags t JOIN nfc_tag_keysets k ON k.org_id = t.org_id AND k.mode = t.mode
    WHERE t.id = NEW.tag_id AND t.system = 'sun' AND k.id = NEW.keyset_id);
  SELECT RAISE(ABORT, 'keyset_disabled') WHERE EXISTS (
    SELECT 1 FROM nfc_tag_keysets k WHERE k.id = NEW.keyset_id AND k.disabled_at IS NOT NULL);
  SELECT RAISE(ABORT, 'tag_key_state') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_keys y WHERE y.keyset_id = NEW.keyset_id AND y.version = NEW.key_version
      AND y.state <> 'retired');
END;
CREATE TRIGGER nfc_tag_sun_update BEFORE UPDATE ON nfc_tag_sun
BEGIN
  SELECT RAISE(ABORT, 'tag_sun_fixed') WHERE NEW.tag_id IS NOT OLD.tag_id OR NEW.keyset_id IS NOT OLD.keyset_id
    OR NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
    OR (OLD.kek_version IS NULL AND NEW.kek_version IS NOT NULL)
    OR ((NEW.kek_version IS NOT OLD.kek_version OR NEW.wrapped_dek IS NOT OLD.wrapped_dek)
      AND NOT (NEW.kek_version IS NOT NULL AND OLD.kek_version IS NOT NULL AND NEW.kek_version > OLD.kek_version
        AND NEW.wrapped_dek IS NOT OLD.wrapped_dek));
  SELECT RAISE(ABORT, 'tag_sun_ctr') WHERE NEW.ctr < OLD.ctr;
  SELECT RAISE(ABORT, 'tag_sun_version') WHERE NEW.key_version < OLD.key_version;
  SELECT RAISE(ABORT, 'tag_key_state') WHERE NEW.key_version <> OLD.key_version AND NOT EXISTS (
    SELECT 1 FROM nfc_tag_keys y WHERE y.keyset_id = NEW.keyset_id AND y.version = NEW.key_version
      AND y.state <> 'retired');
END;

-- Secure is on. The 0128 trigger keeps `nfc_tag_systems` read-only: drop it, change the one row and put it back
-- with the same text, so nothing else can change a system from here on.
DROP TRIGGER nfc_tag_systems_fixed;
UPDATE nfc_tag_systems SET enabled = 1 WHERE id = 'sun';
CREATE TRIGGER nfc_tag_systems_fixed BEFORE UPDATE ON nfc_tag_systems
BEGIN SELECT RAISE(ABORT, 'tag_system_fixed'); END;
