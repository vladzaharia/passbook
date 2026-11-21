import { bumpIfStmt } from '../../platform/counters.ts';
import { first, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { writeSystemValueStmt } from '../settings/repo.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The org setting; the server writes `false` on a lockout, an admin writes `true`. */
export const PIN_ONLY_SETTING = 'scan.pinOnly';

const LOCKOUT_KEY = (orgId: string) => `${PIN_ONLY_SETTING}.lockout:${orgId}`;

/** The lockout the server wrote, and the admin's own setting (written later, it turns PIN-only back on). */
const flagStatements = (db: D1Database, orgId: string) => [
  stmt(db, "SELECT value FROM settings WHERE scope = 'system' AND key = ?", [LOCKOUT_KEY(orgId)]),
  stmt(db, 'SELECT value, updated_at FROM settings WHERE scope = ? AND key = ?', [
    `org:${orgId}`,
    PIN_ONLY_SETTING,
  ]),
];

/** Off when a lockout stands that no later admin `true` has overridden. */
export function pinOnlyIsOff(lock: D1Result, setting: D1Result): boolean {
  const locked = (lock.results[0] as { value?: string } | undefined)?.value;
  if (locked === undefined) return false;
  const row = setting.results[0] as { value?: string; updated_at?: number } | undefined;
  const at = (JSON.parse(locked) as { at: number }).at;
  return !(row?.value === 'true' && (row.updated_at ?? 0) > at);
}

/** Whether PIN-only is off for the org, for the Staff tab. */
export async function pinOnlyOff(db: D1Database, orgId: string): Promise<boolean> {
  const [lock, setting] = await db.batch(flagStatements(db, orgId));
  return lock && setting ? pinOnlyIsOff(lock, setting) : false;
}

/** The flag and the number of active people (the budget scales with it), in one batch. */
export const pinOnlyGateStatements = (db: D1Database, orgId: string) => [
  ...flagStatements(db, orgId),
  stmt(db, 'SELECT COUNT(*) AS count FROM scan_staff WHERE org_id = ? AND disabled_at IS NULL', [
    orgId,
  ]),
];

export const pinOnlyLockoutStatement = (db: D1Database, orgId: string, now: number) =>
  writeSystemValueStmt(db, LOCKOUT_KEY(orgId), { at: now }, now);

/** Days of the last 7 (since the last lockout) on which the org's daily budget ran out. */
export const spentDays = (db: D1Database, orgId: string, now: number) =>
  first<{ days: number }>(
    db,
    `SELECT COUNT(DISTINCT CAST(at / ? AS INTEGER)) AS days FROM audit_log
     WHERE org_id = ? AND action = 'scanner.pin_only_daily_limit'
       AND at > MAX(?, COALESCE((SELECT MAX(at) FROM audit_log WHERE org_id = ? AND action = 'scan.pin_only_off'), 0))`,
    [DAY, orgId, now - 7 * DAY, orgId],
  );

/**
 * The org's budget, reserved before anything is hashed.
 */
export function budgetStatements(
  ctx: ServiceContext,
  orgId: string,
  caps: { hour: number; day: number },
) {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const hour = {
    key: `scan:pinonly:h:${orgId}`,
    window: now - (now % HOUR),
    cap: caps.hour,
  };
  const day = {
    key: `scan:pinonly:d:${orgId}`,
    window: now - (now % DAY),
    cap: caps.day,
  };
  const under = (c: { key: string; window: number; cap: number }) => ({
    sql: 'COALESCE((SELECT count FROM counters WHERE key=? AND window_start=?),0) < ?',
    params: [c.key, c.window, c.cap],
  });
  const held = (c: { key: string; window: number }) => ({
    sql: 'EXISTS (SELECT 1 FROM counters WHERE key=? AND window_start=? AND count>0)',
    params: [c.key, c.window],
  });
  return {
    hour,
    day,
    // Each counter moves only while it is under its own cap, so neither can pass it however many
    // attempts race; a refusal on one releases the slot the other took (`release`).
    reserve: [
      bumpIfStmt(db, hour.key, hour.window, under(hour)),
      bumpIfStmt(db, day.key, day.window, under(day)),
    ],
    refund: () => [
      bumpIfStmt(db, day.key, day.window, held(day), -1),
      bumpIfStmt(db, hour.key, hour.window, held(hour), -1),
    ],
    release: (which: 'hour' | 'day') =>
      which === 'hour'
        ? bumpIfStmt(db, hour.key, hour.window, held(hour), -1)
        : bumpIfStmt(db, day.key, day.window, held(day), -1),
  };
}
