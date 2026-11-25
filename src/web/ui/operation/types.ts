import type { OperationStatus } from '../../lib/status-operations.ts';

export type { OperationStatus };
export type OperationStepState = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';

/**
 * The operation as the API returns it (docs: progress-feedback design §2.1,
 * src/shared/contracts/operations.ts). Kept structural so the kit takes an API body, a local
 * driver's view or a test fixture alike, and no admin-only module is imported.
 */
export interface OperationStep {
  key: string;
  label: string;
  state: OperationStepState;
  done: number | null;
  total: number | null;
  detail: string | null;
  /** A waiting step: when it resumes, or the date it ends by (a tail). */
  until: number | null;
  group: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface OperationError {
  code: string;
  message: string;
  step: string | null;
  retryable: boolean;
}

export interface Operation {
  id: string;
  kind: string;
  status: OperationStatus;
  title: string;
  /** The current line: "Removing Test passes · 4 of 12". */
  text: string;
  /** Titles for the end states; a kind's copy supplies them. */
  doneTitle?: string;
  failTitle?: string;
  orgId: string | null;
  target: { type: string; id: string } | null;
  step: string | null;
  steps: readonly OperationStep[];
  attempt: number;
  cancelable: boolean;
  cancelRequested: boolean;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  error: OperationError | null;
  result: { href: string | null; ids: Record<string, string> } | null;
  revision: number;
  pollAfterMs: number;
}

export const isTerminal = (status: OperationStatus): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'cancelled';
