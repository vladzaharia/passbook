import { OPERATION_KINDS } from '../../../generated/operation-kinds.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { OperationKindDef } from '../../../shared/operations/define.ts';
import { OPERATION_RUNNERS } from '../../generated/operation-runners.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** The Workflow a runner started, for the stall sweep to ask about. */
export interface WorkflowHandle {
  status(): Promise<{ status: string }>;
}

/** The hooks a module gives one kind. All are idempotent: "complete what is missing". */
export interface OperationRunner {
  /**
   * Does the work, reporting through `progressOf(ctx, op.id, op.attempt, lease)`. `lease` is the token
   * `operation.run` claimed; pass it on so a twin runner cannot extend the lease.
   */
  run?: (ctx: ServiceContext, op: OperationDto, lease: string) => Promise<void>;
  /**
   * The start's own checks for a retry: authority, entitlements, rate limit, step-up. Required when the kind
   * retries. It runs before the row is touched, so a refusal burns no attempt; a throw answers the caller.
   */
  authorizeRetry?: (ctx: ServiceContext, op: OperationDto, caller: AuthContext) => Promise<void>;
  /**
   * Relaunches after the row went back to `queued` with the next attempt: a new Workflow instance
   * `<opId>-r<attempt>` (refuse while the old instance is not errored, terminated or complete) or an
   * `operation.run` job, which is the default. A Workflow kind MUST return the new `workflowInstanceId`: the stall
   * sweep checks that instance, not the failed one.
   */
  relaunch?: (
    ctx: ServiceContext,
    op: OperationDto,
  ) => Promise<{ workflowInstanceId?: string } | undefined>;
  /** Tells the work to stop (a stop flag on its own run row). The operation row is already marked. */
  cancel?: (ctx: ServiceContext, op: OperationDto) => Promise<void>;
  /** The kind runs as a Workflow: how to find its instance. */
  workflow?: (ctx: ServiceContext, instanceId: string) => Promise<WorkflowHandle>;
}

export type OperationRunners = Record<string, OperationRunner>;

const kinds = new Map<string, OperationKindDef>(OPERATION_KINDS.map((k) => [k.kind, k]));
const runners = new Map<string, OperationRunner>(Object.entries(OPERATION_RUNNERS));

export const kindOf = (kind: string): OperationKindDef | undefined => kinds.get(kind);
export const runnerOf = (kind: string): OperationRunner | undefined => runners.get(kind);

/** For tests: declare a kind and its hooks. Returns what undoes it. */
export function registerOperationKind(def: OperationKindDef, runner: OperationRunner = {}) {
  kinds.set(def.kind, def);
  runners.set(def.kind, runner);
  return () => {
    kinds.delete(def.kind);
    runners.delete(def.kind);
  };
}

/** The org kinds' distinct read capabilities, for a list that reads across kinds. */
export const orgKinds = (): OperationKindDef[] =>
  [...kinds.values()].filter((k) => k.audience === 'org' && k.read !== null);
