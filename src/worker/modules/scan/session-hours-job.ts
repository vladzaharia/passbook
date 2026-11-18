// Minute cron `scan.session_hours`: side effects of a session opening or closing by its hours. It
// decides nothing (the guard decides at admission) and writes only the bookmark, so it moves no epoch.
import { jobGrant } from '../../platform/authority.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { kickScreen } from './live.ts';
import { scanningDeviceRows } from './repo-scanning-devices.ts';
import { dueHoursRows, type ScanningSessionRow } from './repo-scanning-sessions.ts';
import { nextEdgeAt, openAt } from './session-hours.ts';

export const SESSION_HOURS_JOB = 'scan.session_hours';
export const SESSION_HOURS_BATCH = 200;

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
  const rows = await dueHoursRows(ctx.env.DB, now, SESSION_HOURS_BATCH);
  if (rows.length === 0) return;
  let flips = 0;
  let refused = 0;
  for (const row of rows) {
    try {
      if (!(await settle(ctx, row, now))) continue;
    } catch (error) {
      if (!refusal(error)) throw error;
      refused++;
      ctx.log.warn('scan.session_hours_skip', {
        code: 'SCAN_SESSION_HOURS_REFUSED',
        orgId: row.org_id,
      });
      continue;
    }
    flips++;
    const devices = await scanningDeviceRows(ctx.env.DB, row.org_id, row.id);
    await Promise.all(devices.map((d) => kickScreen(ctx, row.org_id, row.mode, d.scanner_id)));
  }
  ctx.log.info('scan.session_hours', { due: rows.length, flips, refused });
}
