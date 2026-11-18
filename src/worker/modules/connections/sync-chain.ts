import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Totals } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import { syncRunCurrent } from './repo-runs.ts';
import { workflowSyncTracking } from './repo-sync.ts';
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

export function alreadyExists(error: unknown): boolean {
  return error instanceof Error && /already.?exist|instance.*exists/i.test(error.message);
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
  },
  chain: SyncChain,
): Promise<{ started: true } | { started: false; staleCode: StaleCode }> {
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
      id: continuationId(p.runId, chain.seq),
      params: {
        connectionId: p.connectionId,
        orgId: p.orgId,
        generation: p.generation,
        credentialKeysetCommitment: p.credentialKeysetCommitment,
        trigger: p.trigger,
        runId: p.runId,
        chain,
      },
    });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
  sctx.log.info('connection.sync_handoff', { connectionId: p.connectionId, seq: chain.seq });
  return { started: true };
}
