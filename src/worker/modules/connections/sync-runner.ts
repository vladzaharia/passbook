import { connectors } from '../../connectors/registry.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { closeRun } from './health.ts';
import { emptyTotals, type ReleaseBlockCode, type Totals } from './records.ts';
import { getConnection } from './repo.ts';
import { finishRun } from './repo-runs.ts';
import { setWorkflowStatus } from './repo-sync.ts';
import { type Failure, paceMs } from './runtime.ts';
import {
  advanceCursor,
  applySlice,
  dueRefs,
  fetchListPage,
  MAX_PAGES_PER_RUN,
  MAX_RECORDS_PER_STEP,
  startRun,
} from './sync.ts';
import { type Change, runRefs } from './sync-apply.ts';
import type { StepResult } from './sync-context.ts';
import { assertSyncAuthority, assertSyncStart } from './sync-runner-validation.ts';

/** The subset of WorkflowStep the runner needs; tests pass an inline implementation. */
export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export interface SyncRunParams {
  connectionId: string;
  orgId: string;
  generation: number;
  credentialKeysetCommitment: string;
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
  await assertSyncAuthority(sctx, p);
  try {
    await runSync(sctx, step, p);
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' || error.code === 'STALE_CONTEXT')
    )
      throw error;
    sctx.log.error('connection.sync_aborted', { connectionId: p.connectionId, code: 'INTERNAL' });
    try {
      await step.do('abort-record', async () => {
        await assertSyncAuthority(sctx, p);
        const now = sctx.clock.now();
        await finishRun(
          sctx,
          {
            id: p.runId,
            connectionId: p.connectionId,
            finishedAt: now,
            outcome: 'error',
            recordsSeen: 0,
            passesChanged: 0,
            errorCode: 'INTERNAL',
            errorDetail: null,
            httpStatus: null,
            credentialKeysetCommitment: p.credentialKeysetCommitment,
            workflowInstanceId: p.instanceId,
          },
          { orgId: p.orgId },
        );
        await setWorkflowStatus(
          sctx.env.DB,
          p.instanceId,
          'errored',
          now,
          'INTERNAL',
          undefined,
          p.credentialKeysetCommitment,
          p,
        );
      });
    } catch {
      sctx.log.error('connection.sync_abort_record_failed', { code: 'INTERNAL' });
    }
    throw error;
  }
}

async function runSync(sctx: ServiceContext, step: StepLike, p: SyncRunParams): Promise<void> {
  const start = await step.do('start', () => startRun(sctx, p));
  assertSyncStart(start, p);

  const totals = emptyTotals();
  const samples: string[] = [];
  let failure: Failure | null = null;
  let stale = false;
  let releaseBlocked: ReleaseBlockCode | undefined;
  let staleCode: 'STALE_CONTEXT' | 'STALE_GENERATION' = 'STALE_CONTEXT';

  if (!start.ok) {
    if (start.reason === 'GONE') {
      await step.do('mark-gone', async () => {
        await assertSyncAuthority(sctx, p);
        await setWorkflowStatus(
          sctx.env.DB,
          p.instanceId,
          'complete',
          sctx.clock.now(),
          null,
          undefined,
          p.credentialKeysetCommitment,
          p,
        );
      });
      return;
    }
    if (start.reason === 'STALE_GENERATION') {
      stale = true;
      staleCode = 'STALE_GENERATION';
    } else if (start.reason === 'STALE_CONTEXT' || start.reason === 'ORG_INACTIVE') {
      stale = true;
      staleCode = 'STALE_CONTEXT';
    } else {
      failure = { code: start.reason, httpStatus: null, retryAfterMs: null };
    }
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
      if (
        !r ||
        typeof r !== 'object' ||
        typeof r.stale !== 'boolean' ||
        (r.failure !== null &&
          (!r.failure || typeof r.failure !== 'object' || typeof r.failure.code !== 'string')) ||
        !Array.isArray(r.samples) ||
        !Number.isSafeInteger(r.seen) ||
        r.seen < 0 ||
        !Number.isSafeInteger(r.changed) ||
        r.changed < 0 ||
        !Number.isSafeInteger(r.created) ||
        r.created < 0 ||
        !Number.isSafeInteger(r.missing) ||
        r.missing < 0 ||
        !Number.isSafeInteger(r.errors) ||
        r.errors < 0 ||
        (!r.stale && r.staleCode !== undefined)
      ) {
        stale = true;
        staleCode = 'STALE_CONTEXT';
        return false;
      }
      add(totals, r);
      for (const sample of r.samples) if (samples.length < MAX_SAMPLES) samples.push(sample);
      failure ??= r.failure;
      releaseBlocked ??= r.releaseBlocked;
      if (r.stale) {
        stale = true;
        staleCode = r.staleCode === 'STALE_GENERATION' ? 'STALE_GENERATION' : 'STALE_CONTEXT';
      }
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
              mode: start.mode,
              credentialKeysetCommitment: p.credentialKeysetCommitment,
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
                mode: start.mode,
                changes,
                credentialKeysetCommitment: p.credentialKeysetCommitment,
                release: start.release,
              }),
            );
            if (!take(r)) break pages;
            const requests = changes.filter((c) => !c.deleted && !c.record).length;
            if (requests > 0 && i + slice < fetched.changes.length) {
              await step.sleep(`page-${page}-pace-${i}`, paceMs(requests, limits.rpm));
            }
          }
          // Continue updating existing passes, but never advance past blocked issuance.
          if (!releaseBlocked) {
            const moved = await step.do(`page-${page}-cursor`, () =>
              advanceCursor(sctx, {
                connectionId: p.connectionId,
                orgId: p.orgId,
                generation: p.generation,
                mode: start.mode,
                credentialKeysetCommitment: p.credentialKeysetCommitment,
                cursor: fetched.cursor,
              }),
            );
            if (moved?.stale !== false || moved.staleCode) {
              stale = true;
              staleCode =
                moved?.staleCode === 'STALE_GENERATION' ? 'STALE_GENERATION' : 'STALE_CONTEXT';
              break;
            }
          }
          if (!fetched.hasMore) break;
          cursor = fetched.cursor;
          // The next listChanges call is a request too.
          await step.sleep(`page-${page}-list-pace`, paceMs(1, limits.rpm));
        }
      } else {
        const due = await step.do('due', () =>
          dueRefs(sctx, {
            connectionId: p.connectionId,
            orgId: p.orgId,
            generation: p.generation,
            mode: start.mode,
            credentialKeysetCommitment: p.credentialKeysetCommitment,
          }),
        );
        const refs = !due?.staleCode && Array.isArray(due?.refs) ? due.refs : null;
        if (refs === null) {
          stale = true;
          staleCode = due?.staleCode === 'STALE_GENERATION' ? 'STALE_GENERATION' : 'STALE_CONTEXT';
        }
        for (let i = 0; refs && i < refs.length; i += limits.concurrency) {
          const chunk = refs.slice(i, i + limits.concurrency);
          const r = await step.do(`chunk-${i}`, () =>
            runRefs(sctx, {
              connectionId: p.connectionId,
              orgId: p.orgId,
              generation: p.generation,
              mode: start.mode,
              credentialKeysetCommitment: p.credentialKeysetCommitment,
              refs: chunk,
              release: start.release,
            }),
          );
          if (!take(r)) break;
          if (i + limits.concurrency < refs.length) {
            await step.sleep(`pace-${i}`, paceMs(chunk.length, limits.rpm));
          }
        }
      }
    } catch {
      sctx.log.error('connection.sync_failed', { connectionId: p.connectionId, code: 'INTERNAL' });
      failure = { code: 'INTERNAL', httpStatus: null, retryAfterMs: null };
    }
  }

  await assertSyncAuthority(sctx, p);
  await step.do('finish', async () => {
    await assertSyncAuthority(sctx, p);
    return closeRun(
      sctx,
      p.connectionId,
      {
        runId: p.runId,
        instanceId: p.instanceId,
        orgId: p.orgId,
        generation: p.generation,
        source: 'workflow',
        credentialKeysetCommitment: p.credentialKeysetCommitment,
        ...(start.mode !== undefined ? { connectionMode: start.mode } : {}),
        totals,
        failure,
        stale,
        staleCode,
        ...(releaseBlocked ? { releaseBlocked } : {}),
        startedAt: start.startedAt,
        errorDetail: samples.length ? samples.join('\n') : null,
      },
      { countsForBreaker: true },
    );
  });
}
