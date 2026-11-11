import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { emptyTotals, type ReleaseBlockCode, type Totals } from './records.ts';
import { type ConnectionRow, getConnection } from './repo.ts';
import { classify, type Failure, type Prepared, prepare } from './runtime.ts';

export type StaleCode = 'STALE_CONTEXT' | 'STALE_GENERATION';

export interface StepResult extends Totals {
  /** Set when the connector failed; the run stops and passes are left untouched. */
  failure: Failure | null;
  /** The run or a captured pass changed since the work started. */
  stale: boolean;
  staleCode?: StaleCode;
  /** Issuance was blocked by the captured release, independent of stale pass context. */
  releaseBlocked?: ReleaseBlockCode;
  cursor: string | null;
  hasMore: boolean;
  /** First failing records (ref, code, validator message). */
  samples: string[];
}

export const stopped = (
  failure: Failure | null,
  stale: boolean,
  cursor: string | null,
  staleCode: StaleCode = 'STALE_CONTEXT',
): StepResult => ({
  ...emptyTotals(),
  failure,
  stale,
  ...(stale ? { staleCode } : {}),
  cursor,
  hasMore: false,
  samples: [],
});
export async function tryPrepare(
  sctx: ServiceContext,
  conn: ConnectionRow,
): Promise<Prepared | Failure> {
  try {
    return await prepare(sctx, conn);
  } catch (error) {
    return classify(error);
  }
}

/** Resolve a runnable connection without conflating generation drift with other authority loss. */
export async function syncContext(
  sctx: ServiceContext,
  connectionId: string,
  orgId: string,
  generation: number,
  mode: ConnectionRow['mode'],
): Promise<{ conn: ConnectionRow; staleCode?: never } | { conn: null; staleCode: StaleCode }> {
  const conn = await getConnection(sctx.env.DB, connectionId);
  if (
    !orgId ||
    !conn?.enabled ||
    conn.orgId !== orgId ||
    conn.mode !== mode ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Number.isSafeInteger(conn.generation) ||
    conn.generation < 1 ||
    !(await isOrgActive(sctx, orgId))
  ) {
    return { conn: null, staleCode: 'STALE_CONTEXT' };
  }
  return conn.generation === generation ? { conn } : { conn: null, staleCode: 'STALE_GENERATION' };
}

export { syncKeysetCurrent } from './keyset-current.ts';
