-- Secure admin (nfc-s4): keysets whose tags carry their own file keys (supplier import), a forced revoke of one
-- key version, a leaked version that can no longer enrol, and a guarded move of tags to a new keyset.
-- Nothing here changes a row: columns are added and five 0129 triggers are replaced.

-- `per_tag`: the keyset holds only the shared meta key. Each tag proves itself with its own file key (its
-- `nfc_tag_sun` envelope); a tag with no row of its own cannot verify, so it must be imported first. The
-- keyset's own file key is random and read by nothing.
ALTER TABLE nfc_tag_keysets ADD COLUMN per_tag INTEGER NOT NULL DEFAULT 0 CHECK (per_tag IN (0, 1));
-- `revoked_at`: a version cut off at once, tags still on it included. Those tags stop verifying until they are
-- written with a newer version's keys.
ALTER TABLE nfc_tag_keys ADD COLUMN revoked_at INTEGER;

DROP TRIGGER nfc_tag_keysets_insert;
CREATE TRIGGER nfc_tag_keysets_insert BEFORE INSERT ON nfc_tag_keysets
BEGIN
  SELECT RAISE(ABORT, 'keyset_disabled') WHERE NEW.disabled_at IS NOT NULL;
  SELECT RAISE(ABORT, 'keyset_limit') WHERE (SELECT count(*) FROM nfc_tag_keysets k
    WHERE k.org_id = NEW.org_id AND k.mode = NEW.mode AND k.disabled_at IS NULL) >= 4;
  SELECT RAISE(ABORT, 'keyset_per_tag') WHERE NEW.per_tag = 1 AND NEW.diversify = 1;
  SELECT RAISE(ABORT, 'keyset_type_tenant') WHERE NEW.type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.org_id = NEW.org_id AND y.system = 'sun');
END;
DROP TRIGGER nfc_tag_keysets_fixed;
CREATE TRIGGER nfc_tag_keysets_fixed BEFORE UPDATE OF id, org_id, mode, slug, diversify, per_tag, created_at, created_by
  ON nfc_tag_keysets
BEGIN SELECT RAISE(ABORT, 'keyset_fixed'); END;

-- Keys: as 0129, and a revoke is the one way a version with tags still on it, or the active one, becomes
-- retired: `revoked_at` is set once, together with that change, and never cleared.
DROP TRIGGER nfc_tag_keys_update;
CREATE TRIGGER nfc_tag_keys_update BEFORE UPDATE ON nfc_tag_keys
BEGIN
  SELECT RAISE(ABORT, 'tag_key_fixed') WHERE NEW.id IS NOT OLD.id OR NEW.keyset_id IS NOT OLD.keyset_id
    OR NEW.version IS NOT OLD.version OR NEW.created_at IS NOT OLD.created_at
    OR NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
    OR ((NEW.kek_version IS NOT OLD.kek_version OR NEW.wrapped_dek IS NOT OLD.wrapped_dek)
      AND NOT (NEW.kek_version > OLD.kek_version AND NEW.wrapped_dek IS NOT OLD.wrapped_dek));
  SELECT RAISE(ABORT, 'tag_key_revoked') WHERE NEW.revoked_at IS NOT OLD.revoked_at
    AND NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
      AND OLD.state IN ('active', 'retiring') AND NEW.state = 'retired');
  SELECT RAISE(ABORT, 'tag_key_state') WHERE NOT (NEW.state = OLD.state
    OR (OLD.state = 'active' AND NEW.state = 'retiring')
    OR (OLD.state = 'retiring' AND NEW.state = 'retired')
    OR (OLD.state = 'active' AND NEW.state = 'retired' AND (NEW.revoked_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM nfc_tag_keysets k WHERE k.id = OLD.keyset_id AND k.disabled_at IS NOT NULL))));
  SELECT RAISE(ABORT, 'tag_key_in_use') WHERE NEW.state = 'retired' AND OLD.state <> 'retired'
    AND NEW.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM nfc_tag_sun s WHERE s.keyset_id = OLD.keyset_id AND s.key_version = OLD.version)
    AND NOT EXISTS (SELECT 1 FROM nfc_tag_keysets k WHERE k.id = OLD.keyset_id AND k.disabled_at IS NOT NULL);
END;

-- Side rows: a new tag enrols only on the keyset's active version (a retiring one verifies known tags only),
-- and a per-tag key belongs to a per_tag keyset and only there.
DROP TRIGGER nfc_tag_sun_insert;
CREATE TRIGGER nfc_tag_sun_insert BEFORE INSERT ON nfc_tag_sun
BEGIN
  SELECT RAISE(ABORT, 'tag_sun_tenant') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tags t JOIN nfc_tag_keysets k ON k.org_id = t.org_id AND k.mode = t.mode
    WHERE t.id = NEW.tag_id AND t.system = 'sun' AND k.id = NEW.keyset_id);
  SELECT RAISE(ABORT, 'keyset_disabled') WHERE EXISTS (
    SELECT 1 FROM nfc_tag_keysets k WHERE k.id = NEW.keyset_id AND k.disabled_at IS NOT NULL);
  SELECT RAISE(ABORT, 'tag_key_state') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_keys y WHERE y.keyset_id = NEW.keyset_id AND y.version = NEW.key_version
      AND y.state = 'active');
  SELECT RAISE(ABORT, 'tag_sun_own_key') WHERE (NEW.kek_version IS NOT NULL) <>
    (SELECT k.per_tag FROM nfc_tag_keysets k WHERE k.id = NEW.keyset_id);
END;

-- As 0129, and a tag moves to another keyset only when it holds no key of its own, the new keyset is live, of
-- the tag's org and mode, takes no per-tag keys, and the tag lands on its active version with its counter kept.
DROP TRIGGER nfc_tag_sun_update;
CREATE TRIGGER nfc_tag_sun_update BEFORE UPDATE ON nfc_tag_sun
BEGIN
  SELECT RAISE(ABORT, 'tag_sun_fixed') WHERE NEW.tag_id IS NOT OLD.tag_id
    OR NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
    OR (OLD.kek_version IS NULL AND NEW.kek_version IS NOT NULL)
    OR ((NEW.kek_version IS NOT OLD.kek_version OR NEW.wrapped_dek IS NOT OLD.wrapped_dek)
      AND NOT (NEW.kek_version IS NOT NULL AND OLD.kek_version IS NOT NULL AND NEW.kek_version > OLD.kek_version
        AND NEW.wrapped_dek IS NOT OLD.wrapped_dek));
  SELECT RAISE(ABORT, 'tag_sun_move') WHERE NEW.keyset_id IS NOT OLD.keyset_id AND (
    OLD.kek_version IS NOT NULL OR NEW.ctr IS NOT OLD.ctr
    OR NOT EXISTS (
      SELECT 1 FROM nfc_tags t
        JOIN nfc_tag_keysets k ON k.org_id = t.org_id AND k.mode = t.mode
        JOIN nfc_tag_keys y ON y.keyset_id = k.id
      WHERE t.id = NEW.tag_id AND k.id = NEW.keyset_id AND k.disabled_at IS NULL AND k.per_tag = 0
        AND y.version = NEW.key_version AND y.state = 'active'));
  SELECT RAISE(ABORT, 'tag_sun_ctr') WHERE NEW.ctr < OLD.ctr;
  SELECT RAISE(ABORT, 'tag_sun_version') WHERE NEW.keyset_id IS OLD.keyset_id AND NEW.key_version < OLD.key_version;
  SELECT RAISE(ABORT, 'tag_key_state') WHERE NEW.key_version <> OLD.key_version AND NOT EXISTS (
    SELECT 1 FROM nfc_tag_keys y WHERE y.keyset_id = NEW.keyset_id AND y.version = NEW.key_version
      AND y.state <> 'retired');
END;
