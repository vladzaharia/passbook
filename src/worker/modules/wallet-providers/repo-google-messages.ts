import { all, first, run } from '../../platform/db.ts';

export type GoogleMessageState = 'sending' | 'notified' | 'text' | 'failed' | 'unknown';
export type GoogleMessageReason = 'budget' | 'quota' | 'refused' | 'unconfirmed';

export interface GoogleMessageRow {
  id: string;
  baseVersion: number;
  targetVersion: number;
  notify: boolean;
  state: GoogleMessageState;
}

const COLUMNS = `id, base_version AS baseVersion, target_version AS targetVersion, notify = 1 AS notify, state`;

/** The newest pass version the instance's Google object has been brought to, by an upsert or a message. */
export async function googleMessageBase(
  db: D1Database,
  instanceId: string,
  upsertPassVersion: number | null,
): Promise<number | null> {
  const row = await first<{ target: number | null }>(
    db,
    'SELECT MAX(target_version) AS target FROM wallet_google_messages WHERE instance_id = ?',
    [instanceId],
  );
  const target = row?.target ?? null;
  if (target === null) return upsertPassVersion;
  return upsertPassVersion === null ? target : Math.max(target, upsertPassVersion);
}

export function findOpenGoogleMessage(
  db: D1Database,
  instanceId: string,
): Promise<GoogleMessageRow | null> {
  return first(
    db,
    `SELECT ${COLUMNS} FROM wallet_google_messages WHERE instance_id = ? AND state = 'sending'`,
    [instanceId],
  );
}

/** Written immediately before the POST. False when another try holds the instance's one open row. */
export async function openGoogleMessage(
  db: D1Database,
  p: { id: string; instanceId: string; base: number; target: number; notify: boolean; now: number },
): Promise<boolean> {
  const row = await first(
    db,
    `INSERT INTO wallet_google_messages (id, instance_id, base_version, target_version, notify, state, created_at)
    VALUES (?, ?, ?, ?, ?, 'sending', ?) ON CONFLICT DO NOTHING RETURNING id`,
    [p.id, p.instanceId, p.base, p.target, p.notify ? 1 : 0, p.now],
  );
  return row !== null;
}

/** Settles an open row once; false when it was already settled, so its event is written once. */
export async function settleGoogleMessage(
  db: D1Database,
  p: {
    id: string;
    state: Exclude<GoogleMessageState, 'sending'>;
    reason: GoogleMessageReason | null;
    httpStatus: number | null;
    now: number;
  },
): Promise<boolean> {
  const row = await first(
    db,
    `UPDATE wallet_google_messages SET state = ?, reason = ?, http_status = ?, settled_at = ?
    WHERE id = ? AND state = 'sending' RETURNING id`,
    [p.state, p.reason, p.httpStatus, p.now, p.id],
  );
  return row !== null;
}

/** A row that was not sent and may be tried again: its attempt is erased. */
export async function dropOpenGoogleMessage(db: D1Database, id: string): Promise<void> {
  await run(db, "DELETE FROM wallet_google_messages WHERE id = ? AND state = 'sending'", [id]);
}

/** Notifying messages of the last 24 h and the refusal that closes the window, when there is one. */
export async function googleMessageBudget(
  db: D1Database,
  instanceId: string,
  since: number,
): Promise<{ used: number; quotaAt: number | null; oldest: number | null }> {
  const rows = await all<{ state: string; reason: string | null; at: number }>(
    db,
    `SELECT state, reason, settled_at AS at FROM wallet_google_messages
    WHERE instance_id = ? AND settled_at > ? AND (state = 'notified' OR reason = 'quota') ORDER BY settled_at`,
    [instanceId, since],
  );
  const notified = rows.filter((r) => r.state === 'notified');
  const quota = rows.filter((r) => r.reason === 'quota');
  return {
    used: notified.length,
    quotaAt: quota.at(-1)?.at ?? null,
    oldest: notified[0]?.at ?? null,
  };
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
