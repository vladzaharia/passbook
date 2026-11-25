import { useMemo, useSyncExternalStore } from 'react';
import { stepText } from './text.ts';
import type { Operation, OperationStep } from './types.ts';

export interface LocalStepDef {
  key: string;
  label: string;
  /** The running words: "Removing Test passes". */
  active?: string;
  group?: string;
}

export interface LocalOperationDef {
  kind: string;
  title: string;
  doneTitle?: string;
  failTitle?: string;
  steps: readonly LocalStepDef[];
  /** Stop is offered while it runs. */
  cancelable?: boolean;
}

let seq = 0;

/**
 * The driver for a flow the browser runs itself (a photo import, a camera pairing): it produces the
 * same `Operation` the server does, so `OperationProgress` draws both. Call `step`, `progress`,
 * `wait`, `fail` and `finish` as the flow moves; `retry` re-runs from the failed step.
 */
export class LocalOperation {
  private op: Operation;
  private subs = new Set<() => void>();
  private readonly active: ReadonlyMap<string, string | undefined>;
  private readonly now: () => number;
  private readonly zone: string | undefined;
  constructor(def: LocalOperationDef, now: () => number = Date.now, zone?: string) {
    this.now = now;
    this.zone = zone;
    this.active = new Map(def.steps.map((s) => [s.key, s.active]));
    const t = this.now();
    this.op = {
      id: `local-${++seq}`,
      kind: def.kind,
      status: 'queued',
      title: def.title,
      doneTitle: def.doneTitle,
      failTitle: def.failTitle,
      text: 'Starting',
      orgId: null,
      target: null,
      step: null,
      steps: def.steps.map(
        (s): OperationStep => ({
          key: s.key,
          label: s.label,
          state: 'pending',
          done: null,
          total: null,
          detail: null,
          until: null,
          group: s.group ?? null,
          startedAt: null,
          finishedAt: null,
        }),
      ),
      attempt: 1,
      cancelable: def.cancelable ?? false,
      cancelRequested: false,
      createdAt: t,
      startedAt: null,
      updatedAt: t,
      finishedAt: null,
      error: null,
      result: null,
      revision: 0,
      pollAfterMs: 1000,
    };
  }

  subscribe = (sub: () => void) => {
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  };
  snapshot = (): Operation => this.op;

  private set(patch: Partial<Operation>, step?: { key: string; patch: Partial<OperationStep> }) {
    const t = this.now();
    const steps = step
      ? this.op.steps.map((s) => (s.key === step.key ? { ...s, ...step.patch } : s))
      : this.op.steps;
    this.op = { ...this.op, ...patch, steps, updatedAt: t, revision: this.op.revision + 1 };
    for (const sub of this.subs) sub();
  }

  private line(key: string, patch: Partial<OperationStep>): string {
    const s = { ...this.op.steps.find((x) => x.key === key), ...patch } as OperationStep;
    return stepText(s, this.active.get(key), this.zone);
  }

  /** The step starts running; `total` turns on its count. */
  step(key: string, { total }: { total?: number } = {}): void {
    const t = this.now();
    const patch: Partial<OperationStep> = {
      state: 'running',
      startedAt: t,
      done: total === undefined ? null : 0,
      total: total ?? null,
    };
    this.set(
      {
        status: 'running',
        step: key,
        startedAt: this.op.startedAt ?? t,
        text: this.line(key, patch),
      },
      { key, patch },
    );
  }

  progress(key: string, done: number, total?: number): void {
    const patch: Partial<OperationStep> = { done, ...(total === undefined ? {} : { total }) };
    this.set({ text: this.line(key, patch) }, { key, patch });
  }

  /** The step is done; the operation stays running until `finish`. */
  complete(key: string): void {
    this.set({}, { key, patch: { state: 'done', finishedAt: this.now() } });
  }

  /** The step waits (for a person, a device) until `until`, or with no date. */
  wait(key: string, text: string, until: number | null = null): void {
    this.set(
      { status: 'waiting', step: key, text },
      { key, patch: { state: 'waiting', until, startedAt: this.now() } },
    );
  }

  fail(key: string, message: string, { code = 'failed', retryable = true } = {}): void {
    this.set(
      {
        status: 'failed',
        step: key,
        finishedAt: this.now(),
        text: message,
        error: { code, message, step: key, retryable },
      },
      { key, patch: { state: 'failed', finishedAt: this.now() } },
    );
  }

  finish(result: Operation['result'] = null): void {
    this.set({
      status: 'succeeded',
      step: null,
      finishedAt: this.now(),
      text: this.op.doneTitle ?? this.op.title,
      result,
    });
  }

  /** Stop was pressed: the flow checks `stopping` between steps and calls `stopped`. */
  requestStop(): void {
    if (this.op.cancelable) this.set({ cancelRequested: true });
  }
  get stopping(): boolean {
    return this.op.cancelRequested;
  }
  stopped(): void {
    this.set({ status: 'cancelled', finishedAt: this.now(), text: 'Stopped' });
  }

  /** After a failure: the failed step goes back to pending, the attempt counts up. */
  retry(): void {
    const key = this.op.error?.step;
    this.set(
      {
        status: 'queued',
        attempt: this.op.attempt + 1,
        error: null,
        finishedAt: null,
        text: 'Starting',
      },
      key ? { key, patch: { state: 'pending', finishedAt: null } } : undefined,
    );
  }
}

/** A driver bound to the component's life, and the operation it shows. */
export function useLocalOperation(
  def: LocalOperationDef,
  zone?: string,
): { operation: Operation; driver: LocalOperation } {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the definition is a constant of the flow.
  const driver = useMemo(() => new LocalOperation(def, Date.now, zone), [def.kind, zone]);
  const operation = useSyncExternalStore(driver.subscribe, driver.snapshot, driver.snapshot);
  return { operation, driver };
}
