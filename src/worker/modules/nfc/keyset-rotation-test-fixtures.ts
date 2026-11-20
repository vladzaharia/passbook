import type { Envelope } from '../../platform/crypto.ts';
import { run } from '../../platform/db.ts';
import { tagKeyKind, versionKind } from './keyset-seal.ts';

/**
 * A keyset version and a sun tag with a per-tag key, sealed as the keyset code seals them (one envelope for
 * the two 16-byte keys, one for the tag key), for the rotation test: the rows keys.rewrap must move.
 */
export async function seedTagKeys(
  db: D1Database,
  c: {
    orgId: string;
    now: number;
    id: () => string;
    seal: (rowId: string, orgId: string, kind: string, text: string) => Promise<Envelope>;
  },
) {
  const keysetId = c.id();
  const keyId = c.id();
  const tagId = c.id();
  await run(
    db,
    `INSERT INTO nfc_tag_keysets (id, org_id, mode, name, slug, diversify, created_at, created_by)
     VALUES (?, ?, 'live', 'Rotation', ?, 1, ?, 'test')`,
    [keysetId, c.orgId, keysetId.replaceAll('-', '').slice(-8), c.now],
  );
  const kind = versionKind('live', keysetId, 1);
  const keys = 'k'.repeat(32);
  const key = await c.seal(keyId, c.orgId, kind, keys);
  await run(
    db,
    `INSERT INTO nfc_tag_keys (id, keyset_id, version, kek_version, iv, wrapped_dek, ciphertext, state, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'active', ?)`,
    [keyId, keysetId, key.kekVersion, key.iv, key.wrappedDek, key.ciphertext, c.now],
  );
  await run(
    db,
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at)
     VALUES (?, ?, 'live', ?, 'sun', 'FFFF', ?)`,
    [tagId, c.orgId, `ffff${tagId.replaceAll('-', '').padEnd(60, '0').slice(0, 60)}`, c.now],
  );
  const tagKind = tagKeyKind('live', keysetId);
  const tagKey = 't'.repeat(16);
  const sealed = await c.seal(tagId, c.orgId, tagKind, tagKey);
  await run(
    db,
    `INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, kek_version, iv, wrapped_dek, ciphertext, ctr, ctr_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?)`,
    [tagId, keysetId, sealed.kekVersion, sealed.iv, sealed.wrappedDek, sealed.ciphertext, c.now],
  );
  return [
    { table: 'nfc_tag_keys', id: keyId, org: c.orgId, kind, text: keys },
    { table: 'nfc_tag_sun', id: tagId, org: c.orgId, kind: tagKind, text: tagKey },
  ];
}
