import type { ScanCounts } from '../../../shared/contracts/scan.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import {
  expectedCountAfterCacheStmt,
  expectedCountFromResults,
  expectedCountStmt,
  managersStmt,
  setExpectedStmt,
  todayStmt,
} from './repo-counts.ts';
import { eventTotalsStmt } from './repo-event-attendance.ts';
import { scanningSessionTodayStmt } from './repo-scanning-sessions.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';

const DAY = 86_400_000;

/** Midnight of the local day in `timeZone`, by the clock the zone shows now. */
export function localDayStart(now: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const local = (at: number) => {
    const parts = formatter.formatToParts(at);
    const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second'),
    );
  };
  const shown = new Date(local(now));
  const target = Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth(), shown.getUTCDate());
  let guess = target;
  let later = guess;
  for (let i = 0; i < 6; i++) {
    const correction = target - local(guess);
    if (correction === 0) return guess;
    guess += correction;
    later = Math.max(later, guess);
  }
  // Where daylight saving skips midnight, the first valid instant of that day is later.
  return later;
}

/** `yyyy-mm-dd` of the local day, for `day:<date>` gates. */
export function localDay(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A client's own midnight is trusted only inside the last 36 hours. */
const trustedDayStart = (now: number, given: number | undefined) =>
  given !== undefined && given <= now && given >= now - 1.5 * DAY ? given : undefined;

export interface CountsRead {
  counts: ScanCounts;
  /** The org has an active Manager, so a PIN can unlock a heads-up. */
  approvals: boolean;
}

export interface CountsPlan {
  /** Run these contiguously in one batch after the request's writes, then hand results to `read`. */
  stmts: D1PreparedStatement[];
  read(results: D1Result[]): Promise<CountsRead>;
}

const rowOf = <T>(result: D1Result | undefined) => (result?.results?.[0] ?? null) as T | null;

/**
 * Counts, including the event cache CAS, ride in the request's existing batch.
 * Pass/action paths supply their already-verified actor CSRF fence as `cacheGuard`;
 * standalone aggregate GETs may use the ordinary actor authority fence alone.
 */
export function planCounts(
  ctx: ServiceContext,
  actor: ScanActor,
  dayStart?: number,
  authorityActor: ScanActor = actor,
  cacheGuard?: { sql: string; params: readonly SqlValue[] },
): CountsPlan {
  return buildCounts(ctx, actor, dayStart, authorityActor, cacheGuard, false);
}

/**
 * Counts that ride the commit batch, after the grant's release. They see the scan's own writes and
 * nothing a concurrent scan wrote later, so a milestone (the Nth arrival) belongs to one scan. No
 * cache write: the expected count is read directly.
 */
export function planCommitCounts(ctx: ServiceContext, actor: ScanActor, dayStart?: number) {
  return buildCounts(ctx, actor, dayStart, actor, undefined, true);
}

function buildCounts(
  ctx: ServiceContext,
  actor: ScanActor,
  dayStart: number | undefined,
  authorityActor: ScanActor,
  cacheGuard: { sql: string; params: readonly SqlValue[] } | undefined,
  inCommit: boolean,
): CountsPlan {
  const db = ctx.env.DB;
  const event = actor.event ? { ...actor.event } : null;
  const templateIds = [...actor.templateIds];
  const orgId = actor.orgId;
  const mode = actor.mode;
  const actorKey = actor.actorKey;
  const timeZone = actor.timeZone;
  const sessionId = actor.scanningSession?.id;
  const configRev = Math.max(
    actor.scanner?.updatedAt ?? 0,
    event?.updatedAt ?? 0,
    actor.scanningSession?.updatedAt ?? 0,
  );
  const guard = cacheGuard ? { sql: cacheGuard.sql, params: [...cacheGuard.params] } : undefined;
  const authority = cloneObservedScanActor(authorityActor);
  // Bind the injected clock as late as possible, when the caller assembles its batch.
  let asOf = ctx.clock.now();
  let prepared: D1PreparedStatement[] | undefined;
  return {
    get stmts() {
      if (!prepared) {
        asOf = ctx.clock.now();
        const since = trustedDayStart(asOf, dayStart) ?? localDayStart(asOf, timeZone);
        prepared = [
          sessionId
            ? scanningSessionTodayStmt(db, orgId, sessionId, mode, since)
            : todayStmt(db, actorKey, orgId, mode, since),
          managersStmt(db, orgId),
        ];
        if (event) {
          prepared.push(eventTotalsStmt(db, orgId, mode, event.id));
          const cache = inCommit
            ? null
            : setExpectedStmt(db, authority, event, templateIds, asOf, guard);
          if (cache)
            prepared.push(cache, expectedCountAfterCacheStmt(db, event, templateIds, asOf));
          else prepared.push(expectedCountStmt(db, event, templateIds, asOf));
        }
      }
      return prepared;
    },
    async read(results) {
      const today = rowOf<{ n: number }>(results[0])?.n ?? 0;
      const approvals = rowOf<{ has: number }>(results[1])?.has === 1;
      let eventCounts: ScanCounts['event'] = null;
      if (event) {
        const totals = rowOf<{ arrived: number; inside: number }>(results[2]);
        const expected = expectedCountFromResults(results[3], results[4]);
        eventCounts = {
          arrived: totals?.arrived ?? 0,
          inside: event.reentry ? (totals?.inside ?? 0) : null,
          expected,
          capacity: event.capacity,
        };
      }
      return { counts: { today, event: eventCounts, asOf, configRev }, approvals };
    },
  };
}
