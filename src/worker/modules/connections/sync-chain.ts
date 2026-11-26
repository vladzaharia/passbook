import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { setWorkflowInstance } from '../operations/repo-write.ts';
import type { Totals } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { syncRunCurrent } from './repo-runs.ts';
import { workflowSyncTracking } from './repo-sync.ts';
import { setChainTip } from './repo-sync-open.ts';
import { type StaleCode, syncContext, syncKeysetCurrent } from './sync-context.ts';
import { assertSyncAuthority } from './sync-runner-validation.ts';

/** Continuations a single run may chain; a longer listing resumes on the next scheduled run. */
export const MAX_HANDOFFS = 50;

/** State a continuation instance carries over from the instance that handed off. */
export interface SyncChain {
  seq: number;
  startedAt: number;
  totals: Totals;
  samples: string[];
}

/** Deterministic id: a retried hand-off step can only ever name the same instance. */
export const continuationId = (runId: string, seq: number): string => `${runId}-c${seq}`;

/** Workflows reports a taken id as `instance.already_exists` (error 10405). */
export function alreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    /instance\.already_exists|already exists|\b10405\b/i.test(error.message)
  );
}

/** Records written so far; what the per-instance budget counts. */
export const spent = (t: Totals): number => t.created + t.changed + t.missing + t.errors;

/** The run stops at the per-instance budget with no hand-off left; the next run resumes. */
export function noteCapped(sctx: ServiceContext, connectionId: string, samples: string[]): void {
  sctx.log.warn('connection.sync_capped', { connectionId, code: 'SYNC_CAPPED' });
  samples.length = Math.min(samples.length, 4);
  samples.push('SYNC_CAPPED: stopped at the run limit; the next run continues');
}

/** A line the connector asked to show on the run (a listing cut short), kept with the first samples. */
export function noteListing(samples: string[], note: string): void {
  samples.length = Math.min(samples.length, 4);
  samples.push(note);
}

const count = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;

export function assertSyncChain(chain: SyncChain | undefined): void {
  if (chain === undefined) return;
  const t = chain?.totals;
  if (
    !chain ||
    !Number.isSafeInteger(chain.seq) ||
    chain.seq < 1 ||
    chain.seq > MAX_HANDOFFS ||
    !Number.isFinite(chain.startedAt) ||
    !Array.isArray(chain.samples) ||
    chain.samples.length > 5 ||
    !chain.samples.every((x) => typeof x === 'string') ||
    !t ||
    ![t.seen, t.changed, t.created, t.missing, t.errors].every(count)
  )
    throw new UnavailableError('Sync context is unavailable.', 'STALE_CONTEXT');
}

/**
 * Starts the next instance of the same run, once the cursor has been persisted. Runs inside a
 * workflow step: a replay after a crash finds the instance by its id and treats it as started.
 */
export async function handOff(
  sctx: ServiceContext,
  p: {
    connectionId: string;
    orgId: string;
    generation: number;
    mode: ConnectionRow['mode'];
    credentialKeysetCommitment: string;
    trigger: 'schedule' | 'webhook' | 'admin';
    runId: string;
    instanceId: string;
    operationId?: string | undefined;
    operationAttempt?: number | undefined;
  },
  chain: SyncChain,
): Promise<{ started: true } | { started: false; staleCode: StaleCode }> {
  // A replay finds the child it already started, whatever state the run has reached since.
  const child = continuationId(p.runId, chain.seq);
  const tip = { instanceId: p.runId, connectionId: p.connectionId, seq: chain.seq };
  let exists = true;
  try {
    await sctx.env.CONNECTION_SYNC.get(child);
  } catch {
    exists = false; // Not created yet: carry on and create it.
  }
  if (exists) {
    await setChainTip(sctx.env.DB, tip);
    return { started: true };
  }
  await assertSyncAuthority(sctx, p);
  if (!(await syncKeysetCurrent(sctx, p.credentialKeysetCommitment)))
    return { started: false, staleCode: 'STALE_CONTEXT' };
  const context = await syncContext(sctx, p.connectionId, p.orgId, p.generation, p.mode);
  if (!context.conn) return { started: false, staleCode: context.staleCode };
  if (!(await syncRunCurrent(sctx.env.DB, { ...p, runId: p.runId })))
    return { started: false, staleCode: 'STALE_CONTEXT' };
  const tracked = await workflowSyncTracking(sctx.env.DB, p);
  if (tracked?.status !== 'running') return { started: false, staleCode: 'STALE_CONTEXT' };
  try {
    await sctx.env.CONNECTION_SYNC.create({
      id: child,
      params: {
        connectionId: p.connectionId,
        orgId: p.orgId,
        generation: p.generation,
        credentialKeysetCommitment: p.credentialKeysetCommitment,
        trigger: p.trigger,
        runId: p.runId,
        chain,
        ...(p.operationId
          ? { operationId: p.operationId, operationAttempt: p.operationAttempt }
          : {}),
      },
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
  // The stall sweep asks about the instance that runs now, not the one that handed over.
  if (p.operationId)
    await setWorkflowInstance(sctx.env.DB, p.operationId, p.operationAttempt ?? 1, child);
  await setChainTip(sctx.env.DB, tip);
  sctx.log.info('connection.sync_handoff', { connectionId: p.connectionId, seq: chain.seq });
  return { started: true };
}
