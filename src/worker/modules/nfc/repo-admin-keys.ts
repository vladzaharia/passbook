import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { first } from '../../platform/db.ts';
import { type EnvelopeRaw, envelopeOf } from './keyset-seal.ts';

/** The admin keys of a programmed tag (K0, K3, K4, sealed), written in the batch that makes the tag. */
export function insertAdminKeys(
  g: Grant,
  tagId: string,
  keyset: { id: string; version: number },
  envelope: Envelope,
  now: number,
): GrantedStatement {
  return g.insertJoined('nfc_tag_admin_keys', {
    parents: { tag_id: tagId },
    columns: [
      'keyset_id',
      'key_version',
      'kek_version',
      'iv',
      'wrapped_dek',
      'ciphertext',
      'created_at',
    ],
    values: [
      keyset.id,
      keyset.version,
      envelope.kekVersion,
      envelope.iv,
      envelope.wrappedDek,
      envelope.ciphertext,
      now,
    ],
    returning: ['tag_id'],
  });
}

/** The sealed admin keys of a tag of this tenant, with the keyset they are bound to. Null: the tag was not programmed here. */
export async function adminKeysOf(
  db: D1Database,
  orgId: string,
  mode: Mode,
  tagId: string,
): Promise<{ keysetId: string; keyVersion: number; envelope: Envelope } | null> {
  const r = await first<EnvelopeRaw & { keyset_id: string; key_version: number }>(
    db,
    `SELECT a.keyset_id, a.key_version, a.kek_version, a.iv, a.wrapped_dek, a.ciphertext
       FROM nfc_tag_admin_keys a JOIN nfc_tags t ON t.id = a.tag_id
      WHERE a.tag_id = ? AND t.org_id = ? AND t.mode = ?`,
    [tagId, orgId, mode],
  );
  return r && { keysetId: r.keyset_id, keyVersion: r.key_version, envelope: envelopeOf(r) };
}
