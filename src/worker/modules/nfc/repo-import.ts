import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { audited, type KeysetAuthority, keysetGrant } from './repo-keysets-write.ts';

/** Refs (of the org and mode) that already name a tag, whatever its system. */
export async function existingRefs(
  db: D1Database,
  orgId: string,
  mode: Mode,
  refs: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < refs.length; i += 90) {
    const part = refs.slice(i, i + 90);
    const rows = await all<{ tag_ref: string }>(
      db,
      `SELECT tag_ref FROM nfc_tags WHERE org_id = ? AND mode = ? AND tag_ref IN (${part.map(() => '?').join(', ')})`,
      [orgId, mode, ...part],
    );
    for (const r of rows) found.add(r.tag_ref);
  }
  return found;
}

export interface ImportedTag {
  tagId: string;
  ref: string;
  hint: string;
  /** The tag's own file key, sealed for this tag, keyset, mode and org. */
  envelope: Envelope;
}

/**
 * Adds tags as spares on a per-tag keyset, in one batch: each its `nfc_tags` row and its side row with the
 * sealed key, the counter at 0, on the active version `version`. A tag that appeared meanwhile (same ref)
 * leaves no side row, so its entry in `inserts` comes back empty. Refused if the keyset was disabled or rotated.
 */
export function importGrant(
  ctx: ServiceContext,
  a: KeysetAuthority,
  keyset: { id: string; version: number },
  tags: ImportedTag[],
): { grant: Grant; inserts: GrantedStatement[] } {
  const now = ctx.clock.now();
  const g = keysetGrant(
    ctx,
    'org_mode.nfc.keyset.import',
    a,
    [
      rowIs('nfc_tag_keysets', keyset.id, { disabled_at: null, per_tag: 1 }),
      exactlyOne(
        'nfc_tag_keys',
        { keyset_id: keyset.id, version: keyset.version, state: 'active' },
        'keyset_id',
      ),
    ],
    ['nfc_tags', 'nfc_tag_sun'],
  );
  const inserts = tags.map((t) => {
    g.upsert(
      'nfc_tags',
      ['id', 'tag_ref', 'system', 'hint', 'label', 'created_at'],
      [t.tagId, t.ref, 'sun', t.hint, null, now],
      { doNothing: true },
    );
    return g.insertJoined('nfc_tag_sun', {
      parents: { tag_id: t.tagId },
      columns: [
        'keyset_id',
        'key_version',
        'kek_version',
        'iv',
        'wrapped_dek',
        'ciphertext',
        'ctr',
        'ctr_at',
      ],
      values: [
        keyset.id,
        keyset.version,
        t.envelope.kekVersion,
        t.envelope.iv,
        t.envelope.wrappedDek,
        t.envelope.ciphertext,
        0,
        now,
      ],
      returning: ['tag_id'],
    });
  });
  audited(g, {
    ctx,
    a,
    keysetId: keyset.id,
    action: 'tag_keyset.import',
    detail: { attempted: tags.length, version: keyset.version },
  });
  return { grant: g, inserts };
}
