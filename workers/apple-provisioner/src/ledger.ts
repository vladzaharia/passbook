import { AscError, type CallRow } from './types.ts';

export const LIMITS = { perMinute: 30, perDay: 200, revokePerHour: 1 } as const;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface Allowed {
  identifier: string;
  ascId: string | null;
  name: string | null;
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
  await db
    .prepare(
      "INSERT INTO asc_calls (call_id, phase, method, target, caller, status, at) VALUES (?, 'refused', ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), method, target, caller, reason.slice(0, 200), at)
    .run();
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
         AND (?2 <> 'revokeCertificate' OR ${counted(HOUR)} < ${LIMITS.revokePerHour})`,
    )
    .bind(callId, method, target, caller, at)
    .run();
  if (res.meta.changes === 1) return;
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
