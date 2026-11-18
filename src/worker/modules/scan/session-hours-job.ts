// Minute cron `scan.session_hours`: side effects of a session opening or closing by its hours. It
// decides nothing (the guard decides at admission) and writes only the bookmark, so it moves no epoch.
import { jobGrant } from '../../platform/authority.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { readSystemValue } from '../settings/repo.ts';
import { kickScreen } from './live.ts';
import { FRESH_STATE, parseBackfillState, saveBackfillState } from './repo-lookup-backfill.ts';
import { scanningDeviceRows } from './repo-scanning-devices.ts';
import { dueHoursRows, type ScanningSessionRow } from './repo-scanning-sessions.ts';
import { nextEdgeAt, openAt } from './session-hours.ts';

export const SESSION_HOURS_JOB = 'scan.session_hours';
export const SESSION_HOURS_BATCH = 200;
const CURSOR = 'scan.sessionHoursCursor';

/** A grant refusal (the row moved, a suspended org) is a skip; anything else is a bug. */
const refusal = (error: unknown) => error instanceof AppError && error.status < 500;

async function settle(ctx: ServiceContext, row: ScanningSessionRow, now: number): Promise<boolean> {
  const due = row.hours_next_at ?? now;
  const opened = openAt(row, now);
  const flipped = openAt(row, due - 1) !== opened;
  const g = jobGrant(ctx, {
    purpose: 'org_mode.job.scan.session_hours',
    job: SESSION_HOURS_JOB,
    orgId: row.org_id,
    mode: row.mode,
    tables: ['scanning_sessions'],
  });
  g.update('scanning_sessions', {
    set: { hours_next_at: nextEdgeAt(row, now) },
    where: { id: row.id, status: 'active', hours_next_at: due },
    require: 'one',
  });
  if (flipped)
    g.add(
      grantedAudit(g, ctx, {
        orgId: row.org_id,
        actorType: 'system',
        action: opened ? 'scanning.session_opened' : 'scanning.session_closed',
        targetType: 'scanning_session',
        targetId: row.id,
        detail: { by: 'hours' },
      }),
    );
  await g.commit();
  return flipped;
}

export async function sweepSessionHours(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  // The batch walks the due sessions by id from a saved cursor, so rows that keep failing cannot
  // keep the healthy ones behind them out of every batch.
  const cursor = parseBackfillState(await readSystemValue(ctx.env.DB, CURSOR)).after;
  let rows = await dueHoursRows(ctx.env.DB, now, SESSION_HOURS_BATCH, cursor);
  if (rows.length === 0 && cursor !== null)
    rows = await dueHoursRows(ctx.env.DB, now, SESSION_HOURS_BATCH, null);
  const next = rows.length < SESSION_HOURS_BATCH ? null : (rows.at(-1)?.id ?? null);
  if (next !== cursor) await saveBackfillState(ctx, CURSOR, { ...FRESH_STATE, after: next });
  if (rows.length === 0) return;
  let flips = 0;
  let refused = 0;
  for (const row of rows) {
    try {
      if (!(await settle(ctx, row, now))) continue;
    } catch (error) {
      // One session the cron cannot write never holds back the rest of the batch.
      refused++;
      const data = { orgId: row.org_id, sessionId: row.id };
      if (refusal(error))
        ctx.log.warn('scan.session_hours_skip', { code: 'SCAN_SESSION_HOURS_REFUSED', ...data });
      else
        ctx.log.error('scan.session_hours_failed', {
          code: 'SCAN_SESSION_HOURS_FAILED',
          ...data,
          error,
        });
      continue;
    }
    flips++;
    try {
      const devices = await scanningDeviceRows(ctx.env.DB, row.org_id, row.id);
      await Promise.all(devices.map((d) => kickScreen(ctx, row.org_id, row.mode, d.scanner_id)));
    } catch (error) {
      ctx.log.warn('scan.session_hours_kick', {
        code: 'SCAN_SESSION_HOURS_KICK_FAILED',
        sessionId: row.id,
        error,
      });
    }
  }
  ctx.log.info('scan.session_hours', { due: rows.length, flips, refused });
}
