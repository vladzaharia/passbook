import type { ServiceContext } from '../../platform/service-context.ts';
import type { ApplyCtx, IdpRpc, Target } from './types.ts';

const WRITABLE = new Set<string>(['console', 'developer', 'support']);
/** A target the binding manages: a writable role or a custom group. */
export const isManaged = (t: string): t is Target => WRITABLE.has(t) || /^g:[a-z]/.test(t);

/** What one run needs: the binding, the run id (one breaker scope), and whether Polaris ID is in dry run. */
export interface RunEnv {
  ctx: ServiceContext;
  rpc: IdpRpc;
  runId: string;
  /** Polaris ID writes are dry: the run records differences and changes nothing in PassBook either. */
  dry: boolean;
  /** Custom targets the binding refuses on their own (renamed or gone). */
  blocked: ReadonlySet<string>;
}

/** `clear`: done with this mark. `fail`: back off and retry. `keep`: leave it due. `stop`: end the run. */
export interface DrainOutcome {
  mark: 'clear' | 'fail' | 'keep';
  stop: boolean;
}

/** The binding's context: one `ref` per run, which is the scope of its breaker. */
export const rpcCtx = (env: RunEnv, job: string, reason: string): ApplyCtx => ({
  ref: `${job}-${env.runId}`,
  reason,
  actor: { kind: 'system', job: `idp_${job}` },
  dryRun: env.dry,
});

/** The targets a subject's run is working on, for the record when a call fails. */
export interface Touched {
  targets: Target[];
}
