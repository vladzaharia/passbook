import type { Mode } from '../../../shared/contracts/common.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { all, first } from '../../platform/db.ts';
import { type EnvelopeRaw, envelopeOf } from './keyset-seal.ts';

export type KeyState = 'active' | 'retiring' | 'retired';

export interface KeysetRow {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  slug: string;
  diversify: boolean;
  /** The tags carry their own file keys (imported); the keyset holds the shared meta key. */
  perTag: boolean;
  createdAt: number;
  disabledAt: number | null;
}

export interface KeyRow {
  version: number;
  state: KeyState;
  createdAt: number;
  stateAt: number | null;
  /** Cut off at once, tags still on it included. */
  revokedAt: number | null;
  /** Tags whose last read used this version. */
  tags: number;
}

interface RawKeyset {
  id: string;
  org_id: string;
  mode: Mode;
  name: string;
  slug: string;
  diversify: number;
  per_tag: number;
  created_at: number;
  disabled_at: number | null;
}

const KEYSET = 'id, org_id, mode, name, slug, diversify, per_tag, created_at, disabled_at';
const keysetOf = (r: RawKeyset): KeysetRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  name: r.name,
  slug: r.slug,
  diversify: r.diversify === 1,
  perTag: r.per_tag === 1,
  createdAt: r.created_at,
  disabledAt: r.disabled_at,
});

export async function keysetById(db: D1Database, id: string): Promise<KeysetRow | null> {
  const row = await first<RawKeyset>(db, `SELECT ${KEYSET} FROM nfc_tag_keysets WHERE id = ?`, [
    id,
  ]);
  return row && keysetOf(row);
}

/** The keyset a SUN URL names. The slug is public; whether it is this caller's is the caller's check. */
export async function keysetBySlug(db: D1Database, slug: string): Promise<KeysetRow | null> {
  const row = await first<RawKeyset>(db, `SELECT ${KEYSET} FROM nfc_tag_keysets WHERE slug = ?`, [
    slug,
  ]);
  return row && keysetOf(row);
}

/** Newest first (ids are UUIDv7). */
export async function keysetsOf(db: D1Database, orgId: string, mode: Mode): Promise<KeysetRow[]> {
  const rows = await all<RawKeyset>(
    db,
    `SELECT ${KEYSET} FROM nfc_tag_keysets WHERE org_id = ? AND mode = ? ORDER BY id DESC`,
    [orgId, mode],
  );
  return rows.map(keysetOf);
}

export const liveKeysetCount = async (db: D1Database, orgId: string, mode: Mode) =>
  (
    await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM nfc_tag_keysets WHERE org_id = ? AND mode = ? AND disabled_at IS NULL',
      [orgId, mode],
    )
  )?.n ?? 0;

/** Versions of the given keysets, oldest first, with the tags on each. Never selects key material. */
export async function keyVersionsOf(
  db: D1Database,
  keysetIds: string[],
): Promise<Map<string, KeyRow[]>> {
  const out = new Map<string, KeyRow[]>();
  if (keysetIds.length === 0) return out;
  const rows = await all<{
    keyset_id: string;
    version: number;
    state: KeyState;
    created_at: number;
    state_at: number | null;
    revoked_at: number | null;
    tags: number;
  }>(
    db,
    `SELECT k.keyset_id, k.version, k.state, k.created_at, k.state_at, k.revoked_at,
        (SELECT count(*) FROM nfc_tag_sun s WHERE s.keyset_id = k.keyset_id AND s.key_version = k.version) AS tags
      FROM nfc_tag_keys k WHERE k.keyset_id IN (${keysetIds.map(() => '?').join(', ')})
      ORDER BY k.keyset_id, k.version`,
    keysetIds,
  );
  for (const r of rows) {
    const list = out.get(r.keyset_id) ?? [];
    list.push({
      version: r.version,
      state: r.state,
      createdAt: r.created_at,
      stateAt: r.state_at,
      revokedAt: r.revoked_at,
      tags: r.tags,
    });
    out.set(r.keyset_id, list);
  }
  return out;
}

export interface VersionEnvelope {
  id: string;
  version: number;
  state: KeyState;
  envelope: Envelope;
}

/** The sealed material of a keyset's versions in these states, newest first. For the verifier (S3) and rotation; no route reads it. */
export async function versionEnvelopes(
  db: D1Database,
  keysetId: string,
  states: readonly KeyState[] = ['active', 'retiring', 'retired'],
): Promise<VersionEnvelope[]> {
  const rows = await all<EnvelopeRaw & { id: string; version: number; state: KeyState }>(
    db,
    `SELECT id, version, state, kek_version, iv, wrapped_dek, ciphertext FROM nfc_tag_keys
      WHERE keyset_id = ? AND state IN (${states.map(() => '?').join(', ')}) ORDER BY version DESC`,
    [keysetId, ...states],
  );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    state: r.state,
    envelope: envelopeOf(r),
  }));
}

export interface OrgVersionEnvelope extends VersionEnvelope {
  keysetId: string;
  mode: Mode;
}

/** Every key version of every keyset of the org, both modes and disabled ones, to check a new key against. */
export async function orgVersionEnvelopes(
  db: D1Database,
  orgId: string,
): Promise<OrgVersionEnvelope[]> {
  const rows = await all<
    EnvelopeRaw & { id: string; version: number; state: KeyState; keyset_id: string; mode: Mode }
  >(
    db,
    `SELECT k.id, k.version, k.state, k.keyset_id, s.mode, k.kek_version, k.iv, k.wrapped_dek, k.ciphertext
      FROM nfc_tag_keys k JOIN nfc_tag_keysets s ON s.id = k.keyset_id WHERE s.org_id = ? LIMIT 5000`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    state: r.state,
    keysetId: r.keyset_id,
    mode: r.mode,
    envelope: envelopeOf(r),
  }));
}
