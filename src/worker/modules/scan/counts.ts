import type { ScanCounts } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import {
  eventCacheStmt,
  eventTotalsStmt,
  expectedCount,
  managersStmt,
  setExpected,
  todayStmt,
} from './repo-counts.ts';

const DAY = 86_400_000;
const EXPECTED_TTL_MS = 60_000;

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
  /** Run these in a batch after every write of the request; hand the results back to `read`. */
  stmts: D1PreparedStatement[];
  read(results: D1Result[]): Promise<CountsRead>;
}

const rowOf = <T>(result: D1Result | undefined) => (result?.results?.[0] ?? null) as T | null;

/** Counts ride in the request's last batch (SA 13.1): one statement each, no round trip of their own. */
export function planCounts(ctx: ServiceContext, actor: ScanActor, dayStart?: number): CountsPlan {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const since = trustedDayStart(now, dayStart) ?? localDayStart(now, actor.timeZone);
  const event = actor.event;
  const stmts = [
    todayStmt(db, actor.actorKey, since),
    managersStmt(db, actor.orgId),
    ...(event
      ? [
          eventTotalsStmt(db, actor.orgId, actor.mode, event.id),
          eventCacheStmt(db, actor.orgId, event.id),
        ]
      : []),
  ];
  return {
    stmts,
    async read(results) {
      const today = rowOf<{ n: number }>(results[0])?.n ?? 0;
      const approvals = rowOf<{ has: number }>(results[1])?.has === 1;
      const configRev = Math.max(actor.scanner?.updatedAt ?? 0, event?.updatedAt ?? 0);
      let eventCounts: ScanCounts['event'] = null;
      if (event) {
        const totals = rowOf<{ arrived: number; inside: number }>(results[2]);
        const cache = rowOf<{ expected: number | null; expected_at: number | null }>(results[3]);
        let expected = cache?.expected ?? 0;
        if (
          cache?.expected === null ||
          cache?.expected === undefined ||
          (cache.expected_at ?? 0) < now - EXPECTED_TTL_MS
        ) {
          expected = await expectedCount(db, event, actor.templateIds);
          await setExpected(db, event.id, expected, now);
        }
        eventCounts = {
          arrived: totals?.arrived ?? 0,
          inside: event.reentry ? (totals?.inside ?? 0) : null,
          expected,
          capacity: event.capacity,
        };
      }
      return { counts: { today, event: eventCounts, asOf: now, configRev }, approvals };
    },
  };
}
