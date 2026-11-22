-- A tag with a key of its own may have that key replaced (after a leak): iv, ciphertext and wrapped key all
-- change together, on a live per-tag keyset, the counter and keyset kept, under a rekey grant, never to a lower KEK version. The 0150 rules otherwise stand:
-- a rewrap raises the KEK version with the same iv and ciphertext; a key is never added to or dropped from a tag.
DROP TRIGGER nfc_tag_sun_update;
CREATE TRIGGER nfc_tag_sun_update BEFORE UPDATE ON nfc_tag_sun
BEGIN
  SELECT RAISE(ABORT, 'tag_sun_fixed') WHERE NEW.tag_id IS NOT OLD.tag_id
    OR (OLD.kek_version IS NULL AND NEW.kek_version IS NOT NULL)
    OR (OLD.kek_version IS NOT NULL AND NEW.kek_version IS NULL)
    OR ((NEW.iv IS NOT OLD.iv OR NEW.ciphertext IS NOT OLD.ciphertext
        OR NEW.kek_version IS NOT OLD.kek_version OR NEW.wrapped_dek IS NOT OLD.wrapped_dek)
      AND NOT (NEW.kek_version IS NOT NULL AND OLD.kek_version IS NOT NULL AND NEW.kek_version > OLD.kek_version
        AND NEW.wrapped_dek IS NOT OLD.wrapped_dek AND NEW.iv IS OLD.iv AND NEW.ciphertext IS OLD.ciphertext)
      AND NOT (NEW.kek_version IS NOT NULL AND OLD.kek_version IS NOT NULL AND NEW.kek_version >= OLD.kek_version AND NEW.keyset_id IS OLD.keyset_id
        AND NEW.iv IS NOT OLD.iv AND NEW.ciphertext IS NOT OLD.ciphertext AND NEW.wrapped_dek IS NOT OLD.wrapped_dek
        AND EXISTS (SELECT 1 FROM nfc_tag_keysets k
          WHERE k.id = NEW.keyset_id AND k.per_tag = 1 AND k.disabled_at IS NULL
          AND EXISTS (SELECT 1 FROM authority_grants g WHERE g.purpose = 'org_mode.nfc.keyset.rekey'
            AND g.org_id = k.org_id AND g.mode = k.mode))));
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
