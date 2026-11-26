import type { OperationResult } from '../../../shared/contracts/operations.ts';

/** Thrown by `checkCancel` at a safe boundary. `fail` turns it into a cancelled operation. */
export class OperationCancelled extends Error {
  constructor() {
    super('The operation was stopped.');
    this.name = 'OperationCancelled';
  }
}

export interface StepHandle {
  /** Sets the count's end ("of 12"). */
  total(n: number): void;
  /** An absolute count; it never goes down within an attempt. Written at most once a second, or at each 10%. */
  count(done: number): Promise<void>;
  done(): Promise<void>;
  skip(): Promise<void>;
  /**
   * One more finished, counted by the database: for work spread over jobs that cannot know each other's count.
   * Answers the count after it, capped at the total; null when nothing was written (the operation ended).
   */
  tick(): Promise<{ done: number; total: number | null } | null>;
}

export interface Progress {
  /** Marks the step running. Repeating it is harmless; a finished step stays finished. */
  step(key: string): StepHandle;
  /**
   * Before a sleep or an external wait: the operation is blocked on this step and tries again at `until`.
   * `due` marks a tail step that ends by `until` instead. `reason` is copy text, never free text.
   */
  waiting(key: string, options: { until?: number; reason?: string; due?: true }): Promise<void>;
  /** Throws OperationCancelled when a stop was asked for. */
  checkCancel(): Promise<void>;
  succeed(result?: OperationResult): Promise<void>;
  fail(error: unknown): Promise<void>;
}

const NOOP_STEP: StepHandle = {
  total: () => {},
  count: async () => {},
  done: async () => {},
  skip: async () => {},
  tick: async () => null,
};
export const NOOP: Progress = {
  step: () => NOOP_STEP,
  waiting: async () => {},
  checkCancel: async () => {},
  succeed: async () => {},
  fail: async () => {},
};

/**
 * The writer token of a Workflow that reports for an operation another runner holds (the purge of a start over): its
 * writes are fenced by attempt, not by the runner lease, which a backstop may be holding at that moment.
 */
export const WORKFLOW_WRITER: unique symbol = Symbol('operation.workflow-writer');

/** A lease token, or the Workflow writer. */
export type Writer = string | typeof WORKFLOW_WRITER;
