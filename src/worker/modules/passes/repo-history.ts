import type { Personalization } from '../../../passkit/types.ts';
import { type PassSource, PassSourceSchema } from '../../../shared/contracts/passes.ts';
import { all, batch, chunk, first, run, stmt } from '../../platform/db.ts';
import type { PassCause } from './repo-map.ts';

export interface VersionRow {
  version: number;
  templateVersion: string;
  cause: PassCause;
  source: PassSource | null;
  actorType: string | null;
  actorId: string | null;
  createdAt: number;
  purged: boolean;
  personalization: Personalization;
  passJson: string | null;
}

interface VersionDbRow {
  version: number;
  template_version: string;
  cause: PassCause;
  source: string | null;
  actor_type: string | null;
  actor_id: string | null;
  created_at: number;
  purged_at: number | null;
  personalization: string;
  pass_json: string | null;
}

const mapVersion = (r: VersionDbRow): VersionRow => ({
  version: r.version,
  templateVersion: r.template_version,
  cause: r.cause,
  source: PassSourceSchema.safeParse(r.source).data ?? null,
  actorType: r.actor_type,
  actorId: r.actor_id,
  createdAt: r.created_at,
  purged: r.purged_at !== null,
  personalization: JSON.parse(r.personalization) as Personalization,
  passJson: r.pass_json,
});

export async function listVersions(
  db: D1Database,
  passId: string,
  limit = 50,
): Promise<VersionRow[]> {
  const rows = await all<VersionDbRow>(
    db,
    'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT ?',
    [passId, limit],
  );
  return rows.map(mapVersion);
}

export async function getVersion(
  db: D1Database,
  passId: string,
  version: number,
): Promise<VersionRow | null> {
  const row = await first<VersionDbRow>(
    db,
    'SELECT * FROM pass_versions WHERE pass_id = ? AND version = ?',
    [passId, version],
  );
  return row ? mapVersion(row) : null;
}

export interface PurgeCandidate {
  passId: string;
  version: number;
  objectKey: string | null;
}

/** Versions with more than `keep` newer rows: everything except the current one and the last `keep`. */
export async function versionsToPurge(
  db: D1Database,
  keep: number,
  limit: number,
  passId?: string,
): Promise<PurgeCandidate[]> {
  const rows = await all<{ pass_id: string; version: number; object_key: string | null }>(
    db,
    `SELECT pv.pass_id, pv.version, pv.object_key FROM pass_versions pv
     WHERE pv.purged_at IS NULL AND (? IS NULL OR pv.pass_id = ?)
       AND (SELECT count(*) FROM pass_versions n WHERE n.pass_id = pv.pass_id AND n.version > pv.version) > ?
     LIMIT ?`,
    [passId ?? null, passId ?? null, keep, limit],
  );
  return rows.map((r) => ({ passId: r.pass_id, version: r.version, objectKey: r.object_key }));
}

export async function markPurged(
  db: D1Database,
  rows: PurgeCandidate[],
  now: number,
): Promise<void> {
  for (const part of chunk(rows, 50)) {
    await batch(
      db,
      part.map((r) =>
        stmt(
          db,
          `UPDATE pass_versions SET purged_at = ?, object_key = NULL, pass_json = NULL, personalization = '{}'
           WHERE pass_id = ? AND version = ?`,
          [now, r.passId, r.version],
        ),
      ),
    );
  }
}

export async function deleteIdempotencyBefore(db: D1Database, before: number): Promise<number> {
  return (await run(db, 'DELETE FROM idempotency_keys WHERE created_at < ?', [before])).changes;
}
