import { connectors } from '../../connectors/registry.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { closeRun } from './health.ts';
import { emptyTotals, type Totals } from './records.ts';
import { getConnection } from './repo.ts';
import { finishRun } from './repo-runs.ts';
import { setWorkflowStatus } from './repo-sync.ts';
import { type Failure, paceMs } from './runtime.ts';
import {
  advanceCursor,
  applySlice,
  type Change,
  dueRefs,
  fetchListPage,
  MAX_PAGES_PER_RUN,
  MAX_RECORDS_PER_STEP,
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
  orgId: string;
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

const MAX_SAMPLES = 5;

/**
 * Pages listChanges when the connector has it, otherwise fans fetchRecord over due passes in chunks
 * of maxConcurrency with a pause between chunks. Pages are applied in slices of at most
 * MAX_RECORDS_PER_STEP records, and every upstream request (list calls included) is paced with
 * step.sleep. Connector failures end the run without touching passes. A run that dies outside the
 * connector handling is recorded as errored before the error propagates.
 */
export async function executeSync(
  sctx: ServiceContext,
  step: StepLike,
  p: SyncRunParams,
): Promise<void> {
  try {
    await runSync(sctx, step, p);
  } catch (error) {
    sctx.log.error('connection.sync_aborted', { connectionId: p.connectionId, error });
    try {
      await step.do('abort-record', async () => {
        const now = sctx.clock.now();
        await finishRun(sctx.env.DB, {
          id: p.runId,
          finishedAt: now,
          outcome: 'error',
          recordsSeen: 0,
          passesChanged: 0,
          errorCode: 'INTERNAL',
          errorDetail: null,
          httpStatus: null,
        });
        await setWorkflowStatus(sctx.env.DB, p.instanceId, 'errored', now, 'INTERNAL');
      });
    } catch (inner) {
      sctx.log.error('connection.sync_abort_record_failed', { error: inner });
    }
    throw error;
  }
}

async function runSync(sctx: ServiceContext, step: StepLike, p: SyncRunParams): Promise<void> {
  const start = await step.do('start', () => startRun(sctx, p));

  const totals = emptyTotals();
  const samples: string[] = [];
  let failure: Failure | null = null;
  let stale = false;
  let staleCode: 'STALE_CONTEXT' | 'STALE_GENERATION' = 'STALE_GENERATION';

  if (!start.ok) {
    if (start.reason === 'GONE') {
      await step.do('mark-gone', () =>
        setWorkflowStatus(sctx.env.DB, p.instanceId, 'complete', sctx.clock.now()),
      );
      return;
    }
    if (start.reason === 'STALE_GENERATION' || start.reason === 'ORG_INACTIVE') stale = true;
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
      for (const sample of r.samples) if (samples.length < MAX_SAMPLES) samples.push(sample);
      failure ??= r.failure;
      stale ||= r.stale;
      if (r.staleCode) staleCode = r.staleCode;
      return !r.failure && !r.stale;
    };
    const slice = Math.min(MAX_RECORDS_PER_STEP, Math.max(limits.concurrency, limits.rpm, 1));
    try {
      if (start.useList) {
        let cursor = start.cursor;
        pages: for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
          const current = cursor;
          const fetched = await step.do(`page-${page}`, () =>
            fetchListPage(sctx, {
              connectionId: p.connectionId,
              orgId: p.orgId,
              generation: p.generation,
              cursor: current,
            }),
          );
          if (!fetched.ok) {
            take(fetched.result);
            break;
          }
          for (let i = 0; i < fetched.changes.length; i += slice) {
            const changes: Change[] = fetched.changes.slice(i, i + slice);
            const r = await step.do(`page-${page}-apply-${i}`, () =>
              applySlice(sctx, {
                connectionId: p.connectionId,
                orgId: p.orgId,
                generation: p.generation,
                changes,
              }),
            );
            if (!take(r)) break pages;
            const requests = changes.filter((c) => !c.deleted && !c.record).length;
            if (requests > 0 && i + slice < fetched.changes.length) {
              await step.sleep(`page-${page}-pace-${i}`, paceMs(requests, limits.rpm));
            }
          }
          const moved = await step.do(`page-${page}-cursor`, () =>
            advanceCursor(sctx, {
              connectionId: p.connectionId,
              orgId: p.orgId,
              generation: p.generation,
              cursor: fetched.cursor,
            }),
          );
          stale ||= moved.stale;
          if (moved.stale || !fetched.hasMore) break;
          cursor = fetched.cursor;
          // The next listChanges call is a request too.
          await step.sleep(`page-${page}-list-pace`, paceMs(1, limits.rpm));
        }
      } else {
        const refs = await step.do('due', () =>
          dueRefs(sctx, { connectionId: p.connectionId, orgId: p.orgId, generation: p.generation }),
        );
        if (refs === null) stale = true;
        for (let i = 0; refs && i < refs.length; i += limits.concurrency) {
          const chunk = refs.slice(i, i + limits.concurrency);
          const r = await step.do(`chunk-${i}`, () =>
            runRefs(sctx, { connectionId: p.connectionId, orgId: p.orgId, generation: p.generation, refs: chunk }),
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
        orgId: p.orgId,
        generation: p.generation,
        totals,
        failure,
        stale,
        staleCode,
        startedAt: start.startedAt,
        errorDetail: samples.length ? samples.join('\n') : null,
      },
      { countsForBreaker: true },
    ),
  );
}
