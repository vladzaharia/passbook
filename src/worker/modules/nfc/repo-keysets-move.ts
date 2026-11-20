import type { Grant } from '../../platform/authority.ts';
import { exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { exists } from '../../platform/authority-cond.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { audited, type KeysetAuthority, keysetGrant } from './repo-keysets-write.ts';

/** Tags on a keyset that hold no key of their own (they can move), and those that do (they stay). */
export async function movableTags(
  db: D1Database,
  keysetId: string,
): Promise<{ movable: number; ownKey: number }> {
  const row = await first<{ movable: number; own: number }>(
    db,
    `SELECT coalesce(sum(kek_version IS NULL), 0) AS movable, coalesce(sum(kek_version IS NOT NULL), 0) AS own
      FROM nfc_tag_sun WHERE keyset_id = ?`,
    [keysetId],
  );
  return { movable: row?.movable ?? 0, ownKey: row?.own ?? 0 };
}

/**
 * Moves every tag of `from` that holds no key of its own to `to`, at the version `toVersion` that is active
 * there now, counters kept. The tags stop verifying until written with `to`'s keys; their bindings stay.
 * Refused if `to` was disabled or rotated meanwhile.
 */
export function reenrolGrant(
  ctx: ServiceContext,
  a: KeysetAuthority,
  move: { from: string; to: string; toVersion: number; tags: number },
): { grant: Grant; moved: ReturnType<Grant['joined']> } {
  const g = keysetGrant(
    ctx,
    'org_mode.nfc.keyset.reenrol',
    a,
    [
      rowIs('nfc_tag_keysets', move.to, { disabled_at: null, per_tag: 0 }),
      exactlyOne(
        'nfc_tag_keys',
        { keyset_id: move.to, version: move.toVersion, state: 'active' },
        'keyset_id',
      ),
    ],
    ['nfc_tag_sun'],
  );
  const moved = g.joined('nfc_tag_sun', {
    via: 'tag_id',
    where: { keyset_id: move.from, kek_version: null },
    set: { keyset_id: move.to, key_version: move.toVersion },
    returning: ['tag_id'],
  });
  audited(
    g,
    {
      ctx,
      a,
      keysetId: move.from,
      action: 'tag_keyset.reenrol',
      detail: { to: move.to, toVersion: move.toVersion, tags: move.tags },
    },
    exists('nfc_tag_keysets', { id: move.to }),
  );
  return { grant: g, moved };
}
