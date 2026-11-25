import { all, first } from '../../platform/db.ts';

/** The last operation of the instance that settled before `version`: what the provider was last told. */
export function priorSucceededOperation(
  db: D1Database,
  instanceId: string,
  version: number,
): Promise<{ kind: 'upsert' | 'revoke'; passVersion: number } | null> {
  return first(
    db,
    `SELECT kind, pass_version AS passVersion FROM wallet_provider_instance_operations
    WHERE instance_id = ? AND version < ? AND state = 'succeeded' ORDER BY version DESC LIMIT 1`,
    [instanceId, version],
  );
}

/** When the pass version was written (its edit), or null once purged. */
export async function passVersionCreatedAt(
  db: D1Database,
  passId: string,
  version: number,
): Promise<number | null> {
  const row = await first<{ at: number }>(
    db,
    'SELECT created_at AS at FROM pass_versions WHERE pass_id = ? AND version = ?',
    [passId, version],
  );
  return row?.at ?? null;
}

const MAX_RANGE = 21;

/**
 * The stored pass.json of each version from `base` to `target`. A gap, a purged version or a range over 21
 * falls back to the two ends; empty when an end is missing.
 */
export async function passJsonsBetween(
  db: D1Database,
  passId: string,
  base: number,
  target: number,
): Promise<string[]> {
  const read = (sql: string, params: number[]) =>
    all<{ pass_json: string | null }>(
      db,
      `SELECT pass_json FROM pass_versions WHERE pass_id = ? AND ${sql} AND pass_json IS NOT NULL ORDER BY version`,
      [passId, ...params],
    );
  if (target - base < MAX_RANGE) {
    const range = await read('version BETWEEN ? AND ?', [base, target]);
    if (range.length === target - base + 1) return range.map((r) => r.pass_json as string);
  }
  const ends = await read('version IN (?, ?)', [base, target]);
  return ends.length === 2 ? ends.map((r) => r.pass_json as string) : [];
}
