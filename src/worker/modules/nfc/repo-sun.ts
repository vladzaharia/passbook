import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { gte, lt, lte } from '../../platform/authority-expr.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { first, stmt } from '../../platform/db.ts';
import { type EnvelopeRaw, envelopeOf } from './keyset-seal.ts';

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
  /** The slug the tap named: pinned to the keyset at commit. */
  slug: string;
  keyVersion: number;
  ctr: number;
  /** A follow-up of this scan (same device, same tag, same counter) presents the read once more: nothing new is consumed. */
  followUp?: string;
}

/** A follow-up may reuse its scan's read for this long. */
export const FOLLOW_UP_MS = 5 * 60_000;

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

/** The sealed own key of the tag with this ref on this keyset, with the id its seal is bound to. Null: it holds none. */
export async function sunTagKeyByRef(
  db: D1Database,
  orgId: string,
  mode: Mode,
  keysetId: string,
  ref: string,
): Promise<{ tagId: string; envelope: Envelope } | null> {
  const row = await first<EnvelopeRaw & { tag_id: string }>(
    db,
    `SELECT t.id AS tag_id, s.kek_version, s.iv, s.wrapped_dek, s.ciphertext
      FROM nfc_tags t JOIN nfc_tag_sun s ON s.tag_id = t.id
      WHERE t.org_id = ? AND t.mode = ? AND t.tag_ref = ? AND s.keyset_id = ? AND s.kek_version IS NOT NULL`,
    [orgId, mode, ref, keysetId],
  );
  return row ? { tagId: row.tag_id, envelope: envelopeOf(row) } : null;
}

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

/** The keyset the read named is still enabled, under the slug the tap used. */
export const sunKeysetCheck = (seen: SunSeen): Check =>
  exactlyOne(
    'nfc_tag_keysets',
    { id: seen.keysetId, slug: seen.slug, disabled_at: null },
    undefined,
    'stale',
  );

/** A new tag enrols only on the keyset's active version, still active at commit: a retiring one verifies known tags only. */
export const sunActiveCheck = (seen: SunSeen): Check =>
  exactlyOne(
    'nfc_tag_keys',
    { keyset_id: seen.keysetId, version: seen.keyVersion, state: 'active' },
    'keyset_id',
    'stale',
  );

/**
 * Refuses the batch unless the keyset is still enabled and this read is still newer than the tag's counter,
 * in the grant's own transaction: of two acts on one read exactly one passes.
 */
export const sunFreshCheck = (tagId: string, seen: SunSeen): Check[] => [
  sunKeysetCheck(seen),
  exactlyOne('nfc_tag_sun', fresh(tagId, seen), 'tag_id', 'stale'),
];

/**
 * A follow-up reuses the read of its own scan: a heads-up of this device (actor and window pinned here, in the grant) on this tag with exactly this
 * counter, not yet followed up, while the tag's counter has not moved past it. Once: `markFollowedUp` in the
 * same batch makes a second one fail this check.
 */
export const sunFollowCheck = (
  tagId: string,
  seen: SunSeen,
  actorKey: string,
  since: number,
): Check[] => [
  sunKeysetCheck(seen),
  exactlyOne(
    'nfc_tag_sun',
    { tag_id: tagId, keyset_id: seen.keysetId, ctr: seen.ctr, key_version: seen.keyVersion },
    'tag_id',
    'stale',
  ),
  exactlyOne(
    'scans',
    {
      id: seen.followUp ?? '',
      tag_id: tagId,
      sun_ctr: seen.ctr,
      state: 'done',
      outcome: 'heads_up',
      actor_key: actorKey,
      at: gte(since),
      sun_followup_at: null,
    },
    undefined,
    'stale',
  ),
];

export function markFollowedUp(g: Grant, scanId: string, now: number): GrantedStatement {
  return g.update('scans', {
    set: { sun_followup_at: now },
    where: { id: scanId, sun_followup_at: null },
    returning: ['id'],
  });
}

/** For a batch: this device's heads-up on the tag with this counter, still open for a follow-up. */
export const sunFollowupStmt = (
  db: D1Database,
  q: { orgId: string; mode: Mode; ref: string; actorKey: string; ctr: number; since: number },
) =>
  stmt(
    db,
    `SELECT s.id FROM scans s JOIN nfc_tags t ON t.id = s.tag_id
      WHERE t.org_id = ? AND t.mode = ? AND t.tag_ref = ? AND s.actor_key = ? AND s.sun_ctr = ?
        AND s.state = 'done' AND s.outcome = 'heads_up' AND s.sun_followup_at IS NULL AND s.at >= ?
      ORDER BY s.at DESC LIMIT 1`,
    [q.orgId, q.mode, q.ref, q.actorKey, q.ctr, q.since],
  );

export const sunFollowupFrom = (result: D1Result | undefined): string | null =>
  (result?.results?.[0] as { id?: string } | undefined)?.id ?? null;

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
