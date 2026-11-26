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
  /** Does the work, reporting through `progressOf(ctx, op.id, op.attempt)`. Queue and in-request runs call it. */
  run?: (ctx: ServiceContext, op: OperationDto) => Promise<void>;
  /**
   * A retry's own start checks (authority, entitlements, rate limit), then the relaunch: a new Workflow
   * instance `<opId>-r<attempt>` or an `operation.run` job. A throw ends the retry as a failure.
   */
  retry?: (ctx: ServiceContext, op: OperationDto, caller: AuthContext) => Promise<void>;
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
