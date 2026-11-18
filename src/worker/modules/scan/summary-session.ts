import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ScanSummarySchema } from '../../../shared/contracts/scan-session.ts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { type ScanActor, tenantScanRole } from './actor.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { withSessionRow } from './repo-read-authority.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { activitySelector } from './repo-session-activity.ts';
import { QUARTER, readSummaryExtras, type SummaryExtras } from './repo-summary-extras.ts';
import { assertSessionReadAuthority } from './scanning-session-authority.ts';
import { resolveSessionScope, type SessionReadAuthority } from './scanning-session-dto.ts';
import { loadScanningSession } from './scanning-sessions.ts';
import { scanSessionCountAuthority } from './scanning-workspace.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
} from './scanning-workspace-observation.ts';
import { staleScanRead } from './stale-read.ts';

type Summary = z.infer<typeof ScanSummarySchema>;

const DAY = 86_400_000;

/**
 * Local hours with scans. A 15-minute step is never split by a zone's offset, and an hour's start
 * is its first instant, so the repeated hour of a clock change is two buckets and a skipped hour has none.
 */
export function hourBuckets(
  quarters: readonly { q: number; n: number; refused: number }[],
  timeZone: string,
): Summary['byHour'] {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const byStart = new Map<number, Summary['byHour'][number]>();
  for (const row of quarters) {
    const at = row.q * QUARTER;
    const got = Object.fromEntries(parts.formatToParts(at).map((p) => [p.type, p.value]));
    const start = at - Number(got.minute) * 60_000;
    const bucket = byStart.get(start) ?? {
      start,
      label: `${got.hour}:00`,
      count: 0,
      refused: 0,
    };
    bucket.count += row.n;
    bucket.refused += row.refused;
    byStart.set(start, bucket);
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

/** What the extra tallies add to a summary, for either scope. */
export function summaryExtrasOf(
  extras: SummaryExtras,
  timeZone: string,
): Pick<Summary, 'timeZone' | 'byHour' | 'byValue' | 'byReason' | 'byStaff' | 'overrides'> {
  return {
    timeZone,
    byHour: hourBuckets(extras.quarters, timeZone),
    byValue: extras.value.map((r) => ({ kind: r.kind, count: r.n, amount: r.amount })),
    byReason: extras.reasons.map((r) => ({ reason: r.reason, count: r.n })),
    byStaff: extras.staff.map((r) => ({
      staffId: r.staff_id,
      name: r.name,
      count: r.n,
      overrides: r.overrides,
      refused: r.refused,
    })),
    overrides: {
      count: extras.overrideCount,
      latest: extras.overrides.map((r) => ({
        scanId: r.id,
        at: r.at,
        staffName: r.staff_name,
        approvedBy: r.approver,
        reason: r.reason,
      })),
    },
  };
}

/**
 * The whole session's tally, read under the viewer's fence and the session row as observed. The
 * session sees staff names and overrides of every device, so it is a Manager's read; null when the
 * fence no longer holds.
 */
export async function sessionSummaryOf(
  context: ServiceContext,
  row: ScanningSessionRow,
  authority: SessionReadAuthority,
  role: ScanRole,
  since?: number,
): Promise<Summary | null> {
  if (role !== 'manager')
    throw new ForbiddenError('Session totals are for Managers.', 'SCAN_SUMMARY_SESSION_FORBIDDEN');
  if (
    !authority ||
    authority.orgId !== row.org_id ||
    authority.mode !== row.mode ||
    (authority.sessionId !== undefined && authority.sessionId !== row.id)
  )
    return null;
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  if (!(await resolveSessionScope(ctx, row)).valid) return null;
  const selector = activitySelector(row);
  if (!selector) return null;
  const now = ctx.clock.now();
  const from = Math.max(since ?? now - DAY, now - DAY);
  const auth = withSessionRow(authority.at(now), row);
  const extras = await readSummaryExtras(ctx.env.DB, auth, selector, { from, to: now });
  if (!extras.authorized) return null;
  const { totals } = extras;
  return {
    from,
    to: now,
    total: totals.total,
    ok: totals.ok,
    headsUp: totals.heads_up,
    refused: totals.refused,
    undone: totals.undone,
    byAction: [],
    firstAt: totals.first_at,
    lastAt: totals.last_at,
    scope: 'session',
    ...summaryExtrasOf(extras, row.time_zone),
  };
}

/** `GET /summary?scope=session` on a scanning device: Manager only, and only inside a session. */
export async function sessionSummaryFor(
  context: ServiceContext,
  sourceActor: ScanActor,
  since?: number,
): Promise<Summary> {
  const actor = cloneObservedScanActor(sourceActor);
  if (!actor.role)
    throw new UnauthenticatedError('Sign in to continue.', 'SCANNER_UNAUTHENTICATED');
  if (actor.role !== 'manager')
    throw new ForbiddenError('Session totals are for Managers.', 'SCAN_SUMMARY_SESSION_FORBIDDEN');
  const observed = actor.scanningSession ? captureObservedScanningSession(actor) : null;
  if (!observed)
    throw new ValidationError('This scanner is not in a session.', [], 'SCAN_NO_SESSION');
  const summary = await sessionSummaryOf(
    context,
    observed.parent,
    scanSessionCountAuthority(actor),
    actor.role,
    since,
  );
  if (!summary) throw await staleScanRead(context, sourceActor);
  return summary;
}

/** The console's Tonight card: the same numbers, under the viewer's tenant authority. */
export async function consoleSessionSummary(
  ctx: ServiceContext,
  id: string,
  mode: Mode,
  authority: TenantPassWrite,
  countAuthority: SessionReadAuthority,
): Promise<Summary> {
  assertSessionReadAuthority(mode, authority, countAuthority);
  const row = await loadScanningSession(ctx, id, mode, countAuthority.orgId);
  const role = countAuthority.tenant ? tenantScanRole(countAuthority.tenant) : null;
  const summary = role ? await sessionSummaryOf(ctx, row, countAuthority, role) : null;
  if (!summary)
    throw new NotFoundError('Scanning session not found.', 'SCANNING_SESSION_NOT_FOUND');
  return summary;
}
