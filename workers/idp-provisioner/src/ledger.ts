import { type Budgeted, type CallRow, IdpError } from './types.ts';

/** Platform-wide budgets (design 3.3). `health` is the provisioner's own config read, capped separately. */
export const LIMITS: Record<Budgeted, { perMinute: number; perDay: number }> = {
  createSignup: { perMinute: 10, perDay: 50 },
  addDeveloper: { perMinute: 10, perDay: 50 },
  removeDeveloper: { perMinute: 20, perDay: 200 },
  proveSignup: { perMinute: 30, perDay: 300 },
  deleteSignup: { perMinute: 30, perDay: 300 },
  health: { perMinute: 6, perDay: 300 },
};
const REFUSALS_PER_MINUTE = 30;
const MINUTE = 60_000;
const DAY = 86_400_000;

/** The provisioner's own alert channel: one JSON line with a stable `code` for Workers Logs alerting. Callers pass ids and counts, never secrets. */
export function alert(level: 'warn' | 'error', code: string, data: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: the single place the provisioner logs leave the process
  console[level](JSON.stringify({ code, ...data }));
}

/** Writes a refusal row; callers then throw. Refusals are rate-capped so a looping caller cannot grow the table. */
export async function logRefusal(
  db: D1Database,
  method: string,
  target: string | null,
  caller: string | null,
  at: number,
  reason: string,
): Promise<void> {
  const res = await db
    .prepare(
      `INSERT INTO idp_calls (call_id, phase, method, target, caller, status, at)
       SELECT ?1, 'refused', ?2, ?3, ?4, ?5, ?6
       WHERE (SELECT count(*) FROM idp_calls WHERE phase = 'refused' AND method = ?2 AND at > ?6 - ${MINUTE}) < ${REFUSALS_PER_MINUTE}`,
    )
    .bind(crypto.randomUUID(), method, target, caller, reason.slice(0, 200), at)
    .run();
  if (res.meta.changes === 0) alert('warn', 'provisioner.refusals_capped', { method });
}

/**
 * Reserves one call against the budget in a single statement, so concurrent calls cannot overshoot.
 * Fails closed: over budget writes a `budget` row and throws IDP_BUDGET without touching Pocket ID.
 */
export async function reserve(
  db: D1Database,
  callId: string,
  method: Budgeted,
  target: string | null,
  caller: string | null,
  at: number,
): Promise<void> {
  const limit = LIMITS[method];
  const counted = (window: number) =>
    `(SELECT count(*) FROM idp_calls WHERE phase = 'start' AND method = ?2 AND at > ?5 - ${window})`;
  const res = await db
    .prepare(
      `INSERT INTO idp_calls (call_id, phase, method, target, caller, at)
       SELECT ?1, 'start', ?2, ?3, ?4, ?5
       WHERE ${counted(MINUTE)} < ${limit.perMinute} AND ${counted(DAY)} < ${limit.perDay}`,
    )
    .bind(callId, method, target, caller, at)
    .run();
  if (res.meta.changes === 1) {
    const day = await dayCount(db, method, at);
    if (day > limit.perDay / 2) alert('error', 'provisioner.budget_high', { method, day });
    return;
  }
  await db
    .prepare(
      "INSERT INTO idp_calls (call_id, phase, method, target, caller, status, at) VALUES (?, 'budget', ?, ?, ?, 'IDP_BUDGET', ?)",
    )
    .bind(callId, method, target, caller, at)
    .run();
  throw new IdpError('IDP_BUDGET', `Call budget reached for ${method}.`);
}

export async function dayCount(db: D1Database, method: string, at: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM idp_calls WHERE phase = 'start' AND method = ? AND at > ? - ${DAY}`,
    )
    .bind(method, at)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function finish(
  db: D1Database,
  callId: string,
  method: string,
  target: string | null,
  caller: string | null,
  outcome: { status: string; requestId: string | null; durationMs: number },
  at: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO idp_calls (call_id, phase, method, target, caller, status, request_id, duration_ms, at) VALUES (?, 'end', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(callId, method, target, caller, outcome.status, outcome.requestId, outcome.durationMs, at)
    .run();
}

export async function readCalls(db: D1Database, since: number): Promise<CallRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, call_id AS callId, phase, method, target, caller, status,
              request_id AS requestId, duration_ms AS durationMs, at
       FROM idp_calls WHERE at >= ? ORDER BY id LIMIT 1000`,
    )
    .bind(since)
    .all<CallRow>();
  return results;
}
