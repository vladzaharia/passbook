import type { OrgCapability } from '../contracts/org-membership.ts';

export type OperationAudience = 'org' | 'starter' | 'platform';

/** `never`: no stop. `queued`: only before it starts. `between-steps` and `items`: the runner stops at a safe boundary. */
export type CancelPolicy = 'never' | 'queued' | 'between-steps' | 'items';

export interface OperationStepDef {
  key: string;
  label: string;
  /** The line while it runs: "Removing Test passes". */
  active?: string;
  /** Shows "4 of 12". */
  counts?: boolean;
  /** Does not hold up Done; it waits after the operation ends. */
  tail?: boolean;
  group?: string;
}

export interface OperationKindDef {
  kind: string;
  audience: OperationAudience;
  /** Org audience: the capability that reads it. */
  read: OrgCapability | null;
  /** Org audience: the capability that stops or retries it. */
  write: OrgCapability | null;
  cancel: CancelPolicy;
  retry: boolean;
  /** Stop and retry need a recent sign-in. */
  stepUp: boolean;
  /**
   * A Workbench token may stop and retry it. Opt in only when every retry writes Test state alone;
   * a kind whose retry also writes state Live uses is left off, and the token is refused.
   */
  tokenActs?: boolean;
  /** The active-subject key: one active operation per subject. */
  dedupe?: (subject: Record<string, string>) => string;
  /** A running row with no heartbeat this long has stalled. */
  stallMs: number;
  title: string;
  doneTitle: string;
  failTitle: string;
  steps: readonly OperationStepDef[];
  /** Catalog sentences for this kind's error codes. */
  errors?: Record<string, string>;
}

/** Declares a kind. The registry collects every `src/shared/operations/kinds/*.ts` through `npm run gen`. */
export function defineOperationKind(def: OperationKindDef): OperationKindDef {
  return def;
}
