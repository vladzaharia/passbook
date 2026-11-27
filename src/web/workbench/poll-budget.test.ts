import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WbTool } from '../../shared/workbench.ts';
import { POLL_MS as SYNC_POLL_MS } from '../admin/passes/detail/sync-api.ts';
import { FEED_POLL_MS } from './events/use-event-feed.ts';
import { ENDPOINTS_POLL_MS, READ_POLL_MS } from './events/use-events.ts';
import {
  CALLS_POLL_MS,
  EVENTS_POLL_MS,
  SUMMARY_POLL_MS as HOME_SUMMARY_POLL_MS,
  PASSES_POLL_MS,
} from './home/data.ts';
import { SUMMARY_POLL_MS } from './host/summary.ts';
import { POLL_MS as LOGS_POLL_MS } from './logs/use-log.ts';
import { LIST_POLL_MS, TAB_POLL_MS } from './passes/use-passes.ts';
import { QS_TICK_MS } from './quickstart/single-poll.ts';

/** The Workbench token's RL_API_TRY is 60 a minute for the whole session; a route keeps well under it. */
const BUDGET_PER_MIN = 40;
const perMin = (...ms: number[]) => ms.reduce((sum, m) => sum + 60_000 / m, 0);

/**
 * Calls a minute a route makes in its worst steady state, beside the shell's summary. Each tool
 * declares its intervals as exported constants; a faster poll raises its route's total and fails here.
 */
const ROUTE_CALLS: Record<WbTool, number> = {
  home: perMin(HOME_SUMMARY_POLL_MS, CALLS_POLL_MS, EVENTS_POLL_MS, PASSES_POLL_MS),
  // One shared loop: the listener, captures, home and caught reads take turns on it.
  quickstart: perMin(QS_TICK_MS),
  // The list and the open pass, then the busiest tab: sync reads devices and events, the others read once.
  passes:
    perMin(LIST_POLL_MS, LIST_POLL_MS) +
    Math.max(perMin(SYNC_POLL_MS, SYNC_POLL_MS), perMin(TAB_POLL_MS)),
  events: perMin(FEED_POLL_MS, ENDPOINTS_POLL_MS, READ_POLL_MS, READ_POLL_MS),
  logs: perMin(LOGS_POLL_MS),
  design: 0,
  console: 0,
  inbox: 0,
  activity: 0,
  keys: 0,
  sandbox: 0,
};

describe('Workbench poll budget', () => {
  for (const [tool, calls] of Object.entries(ROUTE_CALLS)) {
    it(`${tool} stays at or under ${BUDGET_PER_MIN} calls a minute with the shell's summary`, () => {
      expect(perMin(SUMMARY_POLL_MS) + calls).toBeLessThanOrEqual(BUDGET_PER_MIN);
    });
  }

  it('every react-query poll in the Workbench backs off through pollEvery', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(path);
      }
    };
    walk(__dirname);
    walk(join(__dirname, '../admin/passes/detail'));
    const bare = files.filter((f) =>
      [...readFileSync(f, 'utf8').matchAll(/refetchInterval:\s*([^\n]*)/g)].some(
        ([, value]) =>
          !/^(pollEvery|false|\(query\) =>$|active \? pollEvery|active && )/.test(value ?? ''),
      ),
    );
    expect(bare).toEqual([]);
  });
});
