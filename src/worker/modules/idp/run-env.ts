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
  /** What this run has done on the main side, against the caps below. */
  counts: { holds: number };
}

/** More owner removals than this in one run is a fault in the feed, not an owner's edit: they are recorded, not acted on. */
export const HOLD_CAP = 10;
/** Likewise for accounts the owner disabled, in one reconcile. */
export const DISABLED_CAP = 20;

/** `clear`: done with this mark. `fail`: back off and retry. `keep`: leave it due. `stop`: end the run. */
export interface DrainOutcome {
  mark: 'clear' | 'fail' | 'keep';
  stop: boolean;
  /** Targets the subject's run looked at: each counts against the run's cap. */
  targets: number;
}

/**
 * The binding's context. The `ref` is the scope of its breaker (25 removals, 5 disables): one per hour, whichever
 * run makes the call, so a flood of runs cannot add up to more than one hour's allowance.
 */
export const rpcCtx = (env: RunEnv, job: string, reason: string): ApplyCtx => ({
  ref: `sync-${Math.floor(env.ctx.clock.now() / 3_600_000)}`,
  reason,
  actor: { kind: 'system', job: `idp_${job}` },
  dryRun: env.dry,
});

/** The targets a subject's run is working on, for the record when a call fails. */
export interface Touched {
  targets: Target[];
}
