import { BUCKETS, type Bucket, type CallRow, IdpError } from './types.ts';

/** Platform-wide budgets, per bucket. `health` is the binding's own config read, capped separately. */
export const LIMITS: Record<Bucket, { perMinute: number; perDay: number }> = {
  createSignup: { perMinute: 10, perDay: 50 },
  findByVerifiedEmail: { perMinute: 10, perDay: 50 },
  apply_add: { perMinute: 10, perDay: 100 },
  apply_add_system: { perMinute: 20, perDay: 200 },
  apply_remove: { perMinute: 20, perDay: 200 },
  apply_override: { perMinute: 2, perDay: 10 },
  setDisabled: { perMinute: 5, perDay: 20 },
  snapshot: { perMinute: 1, perDay: 30 },
  proveSignup: { perMinute: 30, perDay: 300 },
  deleteSignup: { perMinute: 30, perDay: 300 },
  lookup: { perMinute: 60, perDay: 1000 },
  health: { perMinute: 6, perDay: 300 },
  // Caller-requested dry runs, so a preview never spends a real bucket such as apply_override.
  preview: { perMinute: 30, perDay: 300 },
  group_write: { perMinute: 2, perDay: 10 },
  claims_write: { perMinute: 10, perDay: 100 },
  claims_read: { perMinute: 30, perDay: 1000 },
  apply_add_group: { perMinute: 10, perDay: 100 },
  apply_add_group_system: { perMinute: 30, perDay: 500 },
  snapshot_group: { perMinute: 120, perDay: 2000 },
  setup_read: { perMinute: 6, perDay: 200 },
  client_write: { perMinute: 3, perDay: 9 },
  scim_write: { perMinute: 1, perDay: 4 },
  scim_sync: { perMinute: 1, perDay: 10 },
};
const REFUSALS_PER_MINUTE = 30;
const MINUTE = 60_000;
const DAY = 86_400_000;

/** What a ledger row says about a call. Ids and short codes only: no email, name, token, url or key. */
export interface Meta {
  method: string;
  target: string | null;
  /** The caller's run or request id. */
  ref: string | null;
  actor: string | null;
  reason: string | null;
  role: string | null;
  delta: string | null;
}
export const meta = (method: string, extra: Partial<Meta> = {}): Meta => ({
  method,
  target: null,
  ref: null,
  actor: null,
  reason: null,
  role: null,
  delta: null,
  ...extra,
});

/** The binding's own alert channel: one JSON line with a stable `code` for Workers Logs alerting. Callers pass ids and counts, never secrets. */
export function alert(level: 'warn' | 'error', code: string, data: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: the single place the binding's logs leave the process
  console[level](JSON.stringify({ code, ...data }));
}

const COLUMNS =
  '(call_id, phase, method, bucket, target, caller, actor, reason, role, delta, status, request_id, duration_ms, at)';

/** Writes a refusal row; callers then throw. Refusals are rate-capped so a looping caller cannot grow the table. */
export async function logRefusal(
  db: D1Database,
  m: Meta,
  at: number,
  reason: string,
): Promise<void> {
  const res = await db
    .prepare(
      `INSERT INTO idp_calls (call_id, phase, method, target, caller, actor, reason, role, delta, status, at)
       SELECT ?1, 'refused', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE (SELECT count(*) FROM idp_calls WHERE phase = 'refused' AND method = ?2 AND at > ?10 - ${MINUTE}) < ${REFUSALS_PER_MINUTE}`,
    )
    .bind(
      crypto.randomUUID(),
      m.method,
      m.target,
      m.ref,
      m.actor,
      m.reason,
      m.role,
      m.delta,
      reason.slice(0, 200),
      at,
    )
    .run();
  if (res.meta.changes === 0) alert('warn', 'binding.refusals_capped', { method: m.method });
}

/** A single phase row (`dry_run`, `breaker`, or the `end` of a call with no reservation) that is not a reservation. */
export async function noteCall(
  db: D1Database,
  phase: 'dry_run' | 'breaker' | 'end',
  m: Meta,
  at: number,
  status: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO idp_calls (call_id, phase, method, target, caller, actor, reason, role, delta, status, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      phase,
      m.method,
      m.target,
      m.ref,
      m.actor,
      m.reason,
      m.role,
      m.delta,
      status,
      at,
    )
    .run();
}

/**
 * Reserves one call per bucket against the budgets, each in a single statement so concurrent calls cannot
 * overshoot. Fails closed: over budget writes a `budget` row and throws IDP_BUDGET without touching Polaris ID.
 */
export async function reserve(
  db: D1Database,
  callId: string,
  bucket: Bucket,
  m: Meta,
  at: number,
): Promise<void> {
  const limit = LIMITS[bucket];
  const counted = (window: number) =>
    `(SELECT count(*) FROM idp_calls WHERE phase = 'start' AND bucket = ?2 AND at > ?10 - ${window})`;
  const values = [callId, bucket, m.method, m.target, m.ref, m.actor, m.reason, m.role, m.delta];
  const res = await db
    .prepare(
      `INSERT INTO idp_calls (call_id, phase, bucket, method, target, caller, actor, reason, role, delta, at)
       SELECT ?1, 'start', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE ${counted(MINUTE)} < ${limit.perMinute} AND ${counted(DAY)} < ${limit.perDay}`,
    )
    .bind(...values, at)
    .run();
  if (res.meta.changes === 1) {
    const day = await dayCount(db, bucket, at);
    if (day > limit.perDay / 2) alert('error', 'binding.budget_high', { bucket, day });
    return;
  }
  await db
    .prepare(
      `INSERT INTO idp_calls (call_id, phase, bucket, method, target, caller, actor, reason, role, delta, status, at)
       VALUES (?, 'budget', ?, ?, ?, ?, ?, ?, ?, ?, 'IDP_BUDGET', ?)`,
    )
    .bind(...values, at)
    .run();
  throw new IdpError('IDP_BUDGET', `Call budget reached for ${bucket}.`);
}

export async function dayCount(db: D1Database, bucket: string, at: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM idp_calls WHERE phase = 'start' AND bucket = ? AND at > ? - ${DAY}`,
    )
    .bind(bucket, at)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function budgetUse(
  db: D1Database,
  at: number,
): Promise<Record<string, { day: number; limit: number }>> {
  const out: Record<string, { day: number; limit: number }> = {};
  for (const b of BUCKETS) out[b] = { day: await dayCount(db, b, at), limit: LIMITS[b].perDay };
  return out;
}

export async function finish(
  db: D1Database,
  callId: string,
  m: Meta,
  outcome: { status: string; requestId: string | null; durationMs: number },
  at: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO idp_calls ${COLUMNS} VALUES (?, 'end', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      callId,
      m.method,
      m.target,
      m.ref,
      m.actor,
      m.reason,
      m.role,
      m.delta,
      outcome.status,
      outcome.requestId,
      outcome.durationMs,
      at,
    )
    .run();
}

export async function readCalls(db: D1Database, since: number, afterId = 0): Promise<CallRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, call_id AS callId, phase, method, bucket, target, caller, actor, reason, role, delta, status,
              request_id AS requestId, duration_ms AS durationMs, at
       FROM idp_calls WHERE at >= ? AND id > ? ORDER BY id LIMIT 1000`,
    )
    .bind(since, afterId)
    .all<CallRow>();
  return results;
}

/** The ledger meta of a write call: ids and short codes from a validated context. */
export const ctxMeta = (
  method: string,
  c: { ref: string; actor: string; reason: string },
  extra: Partial<Meta> = {},
): Meta => meta(method, { ref: c.ref, actor: c.actor, reason: c.reason, ...extra });
