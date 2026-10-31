import { connectors } from '../../connectors/registry.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { closeRun } from './health.ts';
import { emptyTotals, type Totals } from './records.ts';
import { getConnection } from './repo.ts';
import { type Failure, paceMs } from './runtime.ts';
import {
  dueRefs,
  MAX_PAGES_PER_RUN,
  runListPage,
  runRefs,
  type StepResult,
  startRun,
} from './sync.ts';

/** The subset of WorkflowStep the runner needs; tests pass an inline implementation. */
export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export interface SyncRunParams {
  connectionId: string;
  generation: number;
  trigger: 'schedule' | 'webhook' | 'admin';
  runId: string;
  instanceId: string;
}

function add(into: Totals, from: Totals): void {
  into.seen += from.seen;
  into.changed += from.changed;
  into.created += from.created;
  into.missing += from.missing;
  into.errors += from.errors;
}

/**
 * Pages listChanges when the connector has it, otherwise fans fetchRecord over due passes in chunks
 * of maxConcurrency with a pause between chunks. Connector failures end the run without touching passes.
 */
export async function executeSync(
  sctx: ServiceContext,
  step: StepLike,
  p: SyncRunParams,
): Promise<void> {
  const start = await step.do('start', () => startRun(sctx, p));

  const totals = emptyTotals();
  let failure: Failure | null = null;
  let stale = false;

  if (!start.ok) {
    if (start.reason === 'GONE') return;
    if (start.reason === 'STALE_GENERATION') stale = true;
    else failure = { code: start.reason, httpStatus: null, retryAfterMs: null };
  } else {
    const limits = await step.do('limits', async () => {
      const row = await getConnection(sctx.env.DB, p.connectionId);
      const def = row ? connectors.get(row.connectorType) : undefined;
      return {
        rpm: row?.requestsPerMinute ?? def?.defaults.requestsPerMinute ?? 60,
        concurrency: row?.maxConcurrency ?? def?.defaults.maxConcurrency ?? 1,
      };
    });
    const take = (r: StepResult): boolean => {
      add(totals, r);
      failure ??= r.failure;
      stale ||= r.stale;
      return !r.failure && !r.stale;
    };
    try {
      if (start.useList) {
        let cursor = start.cursor;
        for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
          const current = cursor;
          const r = await step.do(`page-${page}`, () =>
            runListPage(sctx, {
              connectionId: p.connectionId,
              generation: p.generation,
              cursor: current,
            }),
          );
          if (!take(r) || !r.hasMore) break;
          cursor = r.cursor;
        }
      } else {
        const refs = await step.do('due', () =>
          dueRefs(sctx, { connectionId: p.connectionId, generation: p.generation }),
        );
        if (refs === null) stale = true;
        for (let i = 0; refs && i < refs.length; i += limits.concurrency) {
          const chunk = refs.slice(i, i + limits.concurrency);
          const r = await step.do(`chunk-${i}`, () =>
            runRefs(sctx, { connectionId: p.connectionId, generation: p.generation, refs: chunk }),
          );
          if (!take(r)) break;
          if (i + limits.concurrency < refs.length) {
            await step.sleep(`pace-${i}`, paceMs(chunk.length, limits.rpm));
          }
        }
      }
    } catch (error) {
      sctx.log.error('connection.sync_failed', { connectionId: p.connectionId, error });
      failure = { code: 'INTERNAL', httpStatus: null, retryAfterMs: null };
    }
  }

  await step.do('finish', () =>
    closeRun(
      sctx,
      p.connectionId,
      {
        runId: p.runId,
        instanceId: p.instanceId,
        generation: p.generation,
        totals,
        failure,
        stale,
        startedAt: start.startedAt,
      },
      { countsForBreaker: true },
    ),
  );
}
