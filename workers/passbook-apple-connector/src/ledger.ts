import { AscError, type CallRow } from './types.ts';

export const LIMITS = {
  perMinute: 30,
  perDay: 200,
  revokePerHour: 1,
  ordersPerTypePer30Days: 2,
  revokesPerTypePerWeek: 1,
} as const;
/** A superseded certificate may be revoked only after its replacement has been out this long and reported active. */
export const REVOKE_COOL_OFF = 24 * 3_600_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export interface Allowed {
  identifier: string;
  ascId: string | null;
  name: string | null;
}

/** The provisioner's own alert channel: one JSON line with a stable `code` for Workers Logs alerting. */
export function alert(level: 'warn' | 'error', code: string, data: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: the single place the provisioner logs leave the process
  console[level](JSON.stringify({ code, ...data }));
}

/** Writes a refusal row; callers then throw. */
export async function logRefusal(
  db: D1Database,
  method: string,
  target: string | null,
  caller: string | null,
  at: number,
  reason: string,
): Promise<void> {
  // Refusals count against the per-minute budget too, so a looping caller cannot grow the table.
  const res = await db
    .prepare(
      `INSERT INTO asc_calls (call_id, phase, method, target, caller, status, at)
       SELECT ?1, 'refused', ?2, ?3, ?4, ?5, ?6
       WHERE (SELECT count(*) FROM asc_calls WHERE phase = 'refused' AND method = ?2 AND at > ?6 - ${MINUTE}) < ${LIMITS.perMinute}`,
    )
    .bind(crypto.randomUUID(), method, target, caller, reason.slice(0, 200), at)
    .run();
  if (res.meta.changes === 0) alert('warn', 'provisioner.refusals_capped', { method });
}

/**
 * Reserves one call against the budget in a single statement, so concurrent calls cannot overshoot.
 * Fails closed: over budget writes a `budget` row and throws ASC_BUDGET without touching Apple.
 */
export async function reserve(
  db: D1Database,
  callId: string,
  method: string,
  target: string | null,
  caller: string | null,
  at: number,
): Promise<void> {
  const counted = (window: number) =>
    `(SELECT count(*) FROM asc_calls WHERE phase = 'start' AND method = ?2 AND at > ?5 - ${window})`;
  const res = await db
    .prepare(
      `INSERT INTO asc_calls (call_id, phase, method, target, caller, at)
       SELECT ?1, 'start', ?2, ?3, ?4, ?5
       WHERE ${counted(MINUTE)} < ${LIMITS.perMinute}
         AND ${counted(DAY)} < ${LIMITS.perDay}
         AND (?2 <> 'revokeCertificate' OR ${counted(HOUR)} < ${LIMITS.revokePerHour})
         AND (?2 <> 'createCertificate' OR (SELECT count(*) FROM asc_calls WHERE phase = 'start' AND method = ?2 AND target = ?3 AND at > ?5 - ${MONTH}) < ${LIMITS.ordersPerTypePer30Days})`,
    )
    .bind(callId, method, target, caller, at)
    .run();
  if (res.meta.changes === 1) {
    const day = await db
      .prepare(
        "SELECT count(*) AS n FROM asc_calls WHERE phase = 'start' AND method = ? AND at > ? - 86400000",
      )
      .bind(method, at)
      .first<{ n: number }>();
    if ((day?.n ?? 0) > LIMITS.perDay / 2)
      alert('error', 'provisioner.budget_high', { method, day: day?.n });
    return;
  }
  await db
    .prepare(
      "INSERT INTO asc_calls (call_id, phase, method, target, caller, status, at) VALUES (?, 'budget', ?, ?, ?, 'ASC_BUDGET', ?)",
    )
    .bind(callId, method, target, caller, at)
    .run();
  throw new AscError('ASC_BUDGET', `Call budget reached for ${method}.`);
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
      "INSERT INTO asc_calls (call_id, phase, method, target, caller, status, apple_request_id, duration_ms, at) VALUES (?, 'end', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(callId, method, target, caller, outcome.status, outcome.requestId, outcome.durationMs, at)
    .run();
}

export async function readCalls(db: D1Database, since: number): Promise<CallRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, call_id AS callId, phase, method, target, caller, status,
              apple_request_id AS appleRequestId, duration_ms AS durationMs, at
       FROM asc_calls WHERE at >= ? ORDER BY id LIMIT 1000`,
    )
    .bind(since)
    .all<CallRow>();
  return results;
}

export async function allowedByAscId(db: D1Database, ascId: string): Promise<Allowed | null> {
  return db
    .prepare('SELECT identifier, asc_id AS ascId, name FROM asc_pass_types WHERE asc_id = ?')
    .bind(ascId)
    .first<Allowed>();
}

export async function allowedByIdentifier(
  db: D1Database,
  identifier: string,
): Promise<Allowed | null> {
  return db
    .prepare('SELECT identifier, asc_id AS ascId, name FROM asc_pass_types WHERE identifier = ?')
    .bind(identifier)
    .first<Allowed>();
}

/** Records a pass type the provisioner created. A seeded row without an id gets it filled in. */
export async function rememberPassType(
  db: D1Database,
  identifier: string,
  ascId: string,
  name: string | null,
  source: 'created' | 'seeded',
  at: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO asc_pass_types (identifier, asc_id, name, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (identifier) DO UPDATE SET asc_id = COALESCE(asc_id, excluded.asc_id), name = COALESCE(name, excluded.name)`,
    )
    .bind(identifier, ascId, name, source, at)
    .run();
}

/** Records a certificate the provisioner ordered. */
export async function rememberCertificate(
  db: D1Database,
  certId: string,
  passTypeAscId: string,
  at: number,
): Promise<void> {
  await db
    .prepare(
      'INSERT OR IGNORE INTO asc_certificates (cert_id, pass_type_asc_id, ordered_at) VALUES (?, ?, ?)',
    )
    .bind(certId, passTypeAscId, at)
    .run();
}

export async function markActive(db: D1Database, certId: string, at: number): Promise<void> {
  await db
    .prepare(
      'UPDATE asc_certificates SET activated_at = ? WHERE cert_id = ? AND activated_at IS NULL',
    )
    .bind(at, certId)
    .run();
}

/** True when another certificate of the type, newer than `certId`, was ordered 24 hours ago or more and is active. */
export async function hasSettledReplacement(
  db: D1Database,
  passTypeAscId: string,
  certId: string,
  at: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM asc_certificates n
       WHERE n.pass_type_asc_id = ?1 AND n.cert_id <> ?2 AND n.activated_at IS NOT NULL
         AND n.ordered_at <= ?3 - ${REVOKE_COOL_OFF}
         AND n.ordered_at > COALESCE((SELECT ordered_at FROM asc_certificates WHERE cert_id = ?2), 0)
       LIMIT 1`,
    )
    .bind(passTypeAscId, certId, at)
    .first();
  return row !== null;
}

/** Takes the pass type's weekly revoke slot in one statement. False when it is already used. */
export async function takeRevokeSlot(
  db: D1Database,
  certId: string,
  passTypeAscId: string,
  at: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO asc_revocations (cert_id, pass_type_asc_id, at)
       SELECT ?1, ?2, ?3
       WHERE (SELECT count(*) FROM asc_revocations WHERE pass_type_asc_id = ?2 AND at > ?3 - ${WEEK}) < ${LIMITS.revokesPerTypePerWeek}`,
    )
    .bind(certId, passTypeAscId, at)
    .run();
  return res.meta.changes === 1;
}
