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
  createdAt: number;
  disabledAt: number | null;
}

export interface KeyRow {
  version: number;
  state: KeyState;
  createdAt: number;
  stateAt: number | null;
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
  created_at: number;
  disabled_at: number | null;
}

const KEYSET = 'id, org_id, mode, name, slug, diversify, created_at, disabled_at';
const keysetOf = (r: RawKeyset): KeysetRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  name: r.name,
  slug: r.slug,
  diversify: r.diversify === 1,
  createdAt: r.created_at,
  disabledAt: r.disabled_at,
});

export async function keysetById(db: D1Database, id: string): Promise<KeysetRow | null> {
  const row = await first<RawKeyset>(db, `SELECT ${KEYSET} FROM nfc_tag_keysets WHERE id = ?`, [
    id,
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
    tags: number;
  }>(
    db,
    `SELECT k.keyset_id, k.version, k.state, k.created_at, k.state_at,
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
