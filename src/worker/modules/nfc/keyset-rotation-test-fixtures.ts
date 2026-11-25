import type { Envelope } from '../../platform/crypto.ts';
import { run } from '../../platform/db.ts';
import { tagKeyKind, versionKind } from './keyset-seal.ts';
import { adminKind, programKind, sessionKind } from './program-seal.ts';

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
    `INSERT INTO nfc_tag_keysets (id, org_id, mode, name, slug, diversify, per_tag, created_at, created_by)
     VALUES (?, ?, 'live', 'Rotation', ?, 0, 1, ?, 'test')`,
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
  // The admin keys of that tag (K0, K3, K4), and a program row holding intended keys (K0 to K4) and a session.
  const admin = adminKind('live', keysetId);
  const adminKeys = 'a'.repeat(48);
  const sealedAdmin = await c.seal(tagId, c.orgId, admin, adminKeys);
  await run(
    db,
    `INSERT INTO nfc_tag_admin_keys (tag_id, keyset_id, key_version, kek_version, iv, wrapped_dek, ciphertext, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      tagId,
      keysetId,
      sealedAdmin.kekVersion,
      sealedAdmin.iv,
      sealedAdmin.wrappedDek,
      sealedAdmin.ciphertext,
      c.now,
    ],
  );
  await run(db, 'UPDATE nfc_tag_keysets SET programmable = 1 WHERE id = ?', [keysetId]);
  const programId = c.id();
  const ref = `abcd${programId.replaceAll('-', '').padEnd(60, '0').slice(0, 60)}`;
  const session = await c.seal(programId, c.orgId, sessionKind('live', keysetId), 'session');
  await run(
    db,
    `INSERT INTO nfc_tag_programs (id, org_id, mode, keyset_id, key_version, tag_ref, hint, actor_type, actor_key,
       purpose, state, step, attempts, sess_kek_version, sess_iv, sess_wrapped_dek, sess_ciphertext,
       created_at, updated_at, expires_at)
     VALUES (?, ?, 'live', ?, 1, ?, 'ABCD', 'scanner', 'scanner:rotation', 'blank', 'started', 'auth', 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      programId,
      c.orgId,
      keysetId,
      ref,
      session.kekVersion,
      session.iv,
      session.wrappedDek,
      session.ciphertext,
      c.now,
      c.now,
      c.now + 60_000,
    ],
  );
  const programKeys = 'p'.repeat(80);
  const program = programKind('live', keysetId);
  const intended = await c.seal(programId, c.orgId, program, programKeys);
  await run(
    db,
    `UPDATE nfc_tag_programs SET state = 'scripted', step = 'result', released_by = 'scanner:rotation', kek_version = ?, iv = ?, wrapped_dek = ?, ciphertext = ?
     WHERE id = ?`,
    [intended.kekVersion, intended.iv, intended.wrappedDek, intended.ciphertext, programId],
  );
  return [
    { table: 'nfc_tag_keys', id: keyId, org: c.orgId, kind, text: keys },
    { table: 'nfc_tag_sun', id: tagId, org: c.orgId, kind: tagKind, text: tagKey },
    { table: 'nfc_tag_admin_keys', id: tagId, org: c.orgId, kind: admin, text: adminKeys },
    { table: 'nfc_tag_programs', id: programId, org: c.orgId, kind: program, text: programKeys },
  ];
}
