import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { lt, lte } from '../../platform/authority-expr.ts';
import { first, stmt } from '../../platform/db.ts';

/** What a SUN tag's side row holds: the keyset and key version of its last read, and that read's counter. */
export interface SunStored {
  tagId: string;
  system: string;
  keysetId: string;
  keyVersion: number;
  ctr: number;
}

/** What a verified read leaves on the tag: the keyset and key version that verified it and the counter it used. */
export interface SunSeen {
  keysetId: string;
  keyVersion: number;
  ctr: number;
}

interface RawStored {
  tag_id: string;
  system: string;
  keyset_id: string;
  key_version: number;
  ctr: number;
}

const STORED = `SELECT t.id AS tag_id, t.system, s.keyset_id, s.key_version, s.ctr
  FROM nfc_tags t JOIN nfc_tag_sun s ON s.tag_id = t.id
  WHERE t.org_id = ? AND t.mode = ? AND t.tag_ref = ?`;

/** For a batch: the side row of the tag with this ref. A `sun` tag without one fails closed. */
export const sunStoredStmt = (db: D1Database, orgId: string, mode: Mode, ref: string) =>
  stmt(db, STORED, [orgId, mode, ref]);

const storedOf = (r: RawStored | null | undefined): SunStored | null =>
  r
    ? {
        tagId: r.tag_id,
        system: r.system,
        keysetId: r.keyset_id,
        keyVersion: r.key_version,
        ctr: r.ctr,
      }
    : null;

export const sunStoredFrom = (result: D1Result | undefined): SunStored | null =>
  storedOf(result?.results?.[0] as RawStored | undefined);

export async function sunStoredByRef(
  db: D1Database,
  orgId: string,
  mode: Mode,
  ref: string,
): Promise<SunStored | null> {
  return storedOf(await first<RawStored>(db, STORED, [orgId, mode, ref]));
}

/** The counter moves up, on the keyset the tag has, to a key version no lower than its last. */
const fresh = (tagId: string, seen: SunSeen) => ({
  tag_id: tagId,
  keyset_id: seen.keysetId,
  ctr: lt(seen.ctr),
  key_version: lte(seen.keyVersion),
});

/**
 * Refuses the batch unless this read is still newer than the tag's counter, in the grant's own transaction:
 * of two acts on one read exactly one passes.
 */
export const sunFreshCheck = (tagId: string, seen: SunSeen): Check =>
  exactlyOne('nfc_tag_sun', fresh(tagId, seen), 'tag_id', 'stale');

/** Consumes the read: the counter and key version of the tag's side row. Needs `sunFreshCheck` in the grant. */
export function consumeSun(g: Grant, tagId: string, seen: SunSeen, now: number): GrantedStatement {
  return g.joined('nfc_tag_sun', {
    via: 'tag_id',
    where: fresh(tagId, seen),
    set: { ctr: seen.ctr, ctr_at: now, key_version: seen.keyVersion },
    returning: ['tag_id'],
  });
}

/** Enrols a new SUN tag: its side row, after its `nfc_tags` row in the same batch. No row if that insert lost a race. */
export function enrolSun(g: Grant, tagId: string, seen: SunSeen, now: number): GrantedStatement {
  return g.insertJoined('nfc_tag_sun', {
    parents: { tag_id: tagId },
    columns: ['keyset_id', 'key_version', 'ctr', 'ctr_at'],
    values: [seen.keysetId, seen.keyVersion, seen.ctr, now],
    returning: ['tag_id'],
  });
}
