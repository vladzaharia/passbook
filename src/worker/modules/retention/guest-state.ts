import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';

const DAY = 86_400_000;
const SINCE = 'retention.guestPassesSince';
const CURSORS = 'retention.guestPassesCursors';
/** The first run only starts the clock: nothing is deleted for this long, so an org can place holds. */
export const GRACE_MS = 7 * DAY;

/** Where each scan stopped last run (`''` is the platform pass, else an org id), so a backlog cannot starve later passes. */
export type Cursors = Record<string, string>;

export async function readCursors(ctx: ServiceContext): Promise<Cursors> {
  const stored = await readSystemValue(ctx.env.DB, CURSORS);
  return stored && typeof stored === 'object' ? (stored as Cursors) : {};
}

export const writeCursors = (ctx: ServiceContext, cursors: Cursors) =>
  writeSystemValue(ctx.env.DB, CURSORS, cursors, ctx.clock.now());

/** When deletion starts: the first run's time plus the grace. The first run records its own time. */
export async function graceEndsAt(ctx: ServiceContext): Promise<number> {
  const now = ctx.clock.now();
  const stored = await readSystemValue(ctx.env.DB, SINCE);
  if (typeof stored === 'number') return stored + GRACE_MS;
  await writeSystemValue(ctx.env.DB, SINCE, now, now);
  return now + GRACE_MS;
}

/** The date guest-plan deletion starts while the grace is on; null once it has begun or before the first run. */
export async function guestPassesFrom(db: D1Database, now: number): Promise<number | null> {
  const row = await first<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE scope = 'system' AND key = ?",
    [SINCE],
  );
  const since = row ? JSON.parse(row.value) : null;
  return typeof since === 'number' && since + GRACE_MS > now ? since + GRACE_MS : null;
}
