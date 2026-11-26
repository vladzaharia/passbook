import {
  type OperationResult,
  OperationResultSchema,
  type OperationStep,
} from '../../../shared/contracts/operations.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { parseSteps } from './dto.ts';
import { kindOf } from './kinds.ts';
import { codeOf, settleSteps, tickStep } from './progress-code.ts';
import {
  NOOP,
  OperationCancelled,
  type Progress,
  type StepHandle,
  type Writer,
} from './progress-types.ts';
import { type OperationRow, rowById } from './repo.ts';
import {
  finish,
  readCancelRequested,
  type Written,
  writeHeartbeat,
  writeStep,
} from './repo-write.ts';
import { KEEP_MS, LEASE_MS } from './start.ts';

const COUNT_EVERY_MS = 1000;
const HEARTBEAT_EVERY_MS = 30_000;
/** A waiting reason is a short sentence: no digit, `@`, `/` or `:`, so no email, token or URL fits. */
const REASON = /^[A-Za-z][A-Za-z ,.'-]{0,79}$/;

interface State {
  row: OperationRow;
  steps: OperationStep[];
  cancelRequested: boolean;
}

class Reporter implements Progress {
  private chain: Promise<void> = Promise.resolve();
  private state: Promise<State | null> | null = null;
  private dead = false;
  private readonly totals = new Map<string, number>();
  private readonly ignored = new Set<string>();
  private readonly lastCount = new Map<string, { at: number; bucket: number }>();
  private lastBeat = 0;
  private lastCancelRead = 0;

  private readonly ctx: ServiceContext;
  private readonly id: string;
  private readonly wanted: number;
  private readonly lease: Writer | null;

  constructor(ctx: ServiceContext, id: string, wanted: number, lease: Writer | null) {
    this.ctx = ctx;
    this.id = id;
    this.wanted = wanted;
    this.lease = lease;
  }

  private load(): Promise<State | null> {
    this.state ??= this.guarded(async () => {
      const row = await rowById(this.ctx.env.DB, this.id);
      // Not found, ended, or a newer attempt: this runner no longer reports.
      if (!row || row.attempt !== this.wanted) return null;
      if (!['queued', 'running', 'waiting'].includes(row.status)) return null;
      return { row, steps: parseSteps(row.steps), cancelRequested: row.cancel_requested === 1 };
    }, null);
    return this.state;
  }

  /** A progress write never fails the job: a D1 error is logged and the job carries on. */
  private async guarded<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.ctx.log.warn('operation.progress_degraded', {
        code: 'OPERATION_PROGRESS_DEGRADED',
        operationId: this.id,
        cause: error instanceof Error ? error.name : 'unknown',
      });
      return fallback;
    }
  }

  private enqueue(fn: (s: State) => Promise<void>): Promise<void> {
    this.chain = this.chain.then(async () => {
      const s = await this.load();
      if (!s || this.dead) return;
      await this.guarded(() => fn(s), undefined);
    });
    return this.chain;
  }

  private note(s: State, written: Written | null) {
    if (!written) this.dead = true;
    else s.cancelRequested = written.cancel_requested === 1;
  }

  private async writeOf(s: State, step: OperationStep, status: 'running' | 'waiting') {
    const now = this.ctx.clock.now();
    const total = this.totals.get(step.key);
    if (total !== undefined) step.total = total;
    this.lastBeat = now;
    this.note(
      s,
      await writeStep(this.ctx.env.DB, {
        id: this.id,
        attempt: s.row.attempt,
        now,
        index: s.steps.indexOf(step),
        stepJson: JSON.stringify(step),
        stepKey: step.key,
        status,
        leaseUntil: now + LEASE_MS,
        lease: this.lease,
      }),
    );
  }

  private stepOf(s: State, key: string): OperationStep | null {
    const step = s.steps.find((x) => x.key === key);
    if (!step) {
      this.ctx.log.warn('operation.step_unknown', {
        code: 'OPERATION_STEP_UNKNOWN',
        operationId: this.id,
        step: key,
      });
      return null;
    }
    return step;
  }

  step(key: string): StepHandle {
    void this.enqueue(async (s) => {
      const step = this.stepOf(s, key);
      if (!step) return;
      if (step.state === 'done' || step.state === 'skipped') {
        this.ignored.add(key);
        return;
      }
      if (step.state === 'running') return;
      step.state = 'running';
      step.until = null;
      step.waitingReason = null;
      step.startedAt ??= this.ctx.clock.now();
      await this.writeOf(s, step, 'running');
    });
    return {
      total: (n) => void this.totals.set(key, n),
      count: (done) => this.enqueue((s) => this.count(s, key, done)),
      done: () => this.enqueue((s) => this.end(s, key, 'done')),
      skip: () => this.enqueue((s) => this.end(s, key, 'skipped')),
      tick: () => this.tick(key),
    };
  }

  private async tick(key: string): Promise<{ done: number; total: number | null } | null> {
    let out: { done: number; total: number | null } | null = null;
    await this.enqueue(async (s) => {
      const step = this.stepOf(s, key);
      if (!step || this.ignored.has(key)) return;
      out = await tickStep(this.ctx, s.row.id, s.row.attempt, s.steps.indexOf(step), this.lease);
      if (!out) this.dead = true;
      else Object.assign(step, out);
    });
    return out;
  }

  private async count(s: State, key: string, done: number) {
    const step = this.stepOf(s, key);
    if (!step || this.ignored.has(key)) return;
    const now = this.ctx.clock.now();
    const total = this.totals.get(key) ?? step.total;
    step.done = Math.max(done, step.done ?? 0);
    if (total !== null && total !== undefined) step.total = total;
    const last = this.lastCount.get(key);
    const bucket = total ? Math.floor((step.done / total) * 10) : 0;
    const due =
      !last ||
      now - last.at >= COUNT_EVERY_MS ||
      bucket > last.bucket ||
      (total ? step.done >= total : false);
    if (due) {
      this.lastCount.set(key, { at: now, bucket });
      await this.writeOf(s, step, 'running');
    } else if (now - this.lastBeat >= HEARTBEAT_EVERY_MS) {
      this.lastBeat = now;
      this.note(
        s,
        await writeHeartbeat(this.ctx.env.DB, {
          id: this.id,
          attempt: s.row.attempt,
          now,
          leaseUntil: now + LEASE_MS,
          lease: this.lease,
        }),
      );
    }
  }

  private async end(s: State, key: string, state: 'done' | 'skipped') {
    const step = this.stepOf(s, key);
    if (!step || this.ignored.has(key)) return;
    step.state = state;
    step.finishedAt = this.ctx.clock.now();
    const total = this.totals.get(key);
    if (total !== undefined) step.total = total;
    await this.writeOf(s, step, 'running');
  }

  waiting(key: string, options: { until?: number; reason?: string; due?: true }): Promise<void> {
    return this.enqueue(async (s) => {
      const step = this.stepOf(s, key);
      if (!step || this.ignored.has(key)) return;
      step.state = 'waiting';
      step.until = options.until ?? null;
      step.waitingReason = options.due ? 'due' : 'blocked';
      step.detail = options.reason && REASON.test(options.reason) ? options.reason : null;
      step.startedAt ??= this.ctx.clock.now();
      await this.writeOf(s, step, 'waiting');
    });
  }

  async checkCancel(): Promise<void> {
    await this.chain;
    const s = await this.load();
    if (!s || this.dead) return;
    const now = this.ctx.clock.now();
    if (!s.cancelRequested && now - this.lastCancelRead >= COUNT_EVERY_MS) {
      this.lastCancelRead = now;
      const flag = await this.guarded(() => readCancelRequested(this.ctx.env.DB, this.id), null);
      s.cancelRequested = flag === 1;
    }
    if (s.cancelRequested) throw new OperationCancelled();
  }

  succeed(result?: OperationResult): Promise<void> {
    return this.enqueue(async (s) => {
      const checked = result === undefined ? null : OperationResultSchema.safeParse(result);
      if (checked && !checked.success)
        this.ctx.log.warn('operation.result_dropped', {
          code: 'OPERATION_RESULT_INVALID',
          operationId: this.id,
        });
      const now = this.ctx.clock.now();
      settleSteps(s.steps, s.row.kind, now);
      await this.close(s, 'succeeded', null, checked?.success ? checked.data : null);
    });
  }

  fail(error: unknown): Promise<void> {
    return this.enqueue(async (s) => {
      const now = this.ctx.clock.now();
      if (error instanceof OperationCancelled) {
        for (const step of s.steps)
          if (['pending', 'running', 'waiting'].includes(step.state)) {
            step.state = 'skipped';
            step.finishedAt = now;
          }
        await this.close(s, 'cancelled', null, null);
        return;
      }
      const code = codeOf(this.ctx, this.id, error);
      // The step that was running; a tail that waits after Done (the erase) is not what failed.
      const tail = (key: string) =>
        kindOf(s.row.kind)?.steps.find((d) => d.key === key)?.tail === true;
      const failing =
        s.steps.find((x) => x.state === 'running') ??
        s.steps.find((x) => x.state === 'waiting' && !tail(x.key)) ??
        s.steps.find((x) => x.state === 'pending');
      if (failing) {
        failing.state = 'failed';
        failing.finishedAt = now;
      }
      await this.close(
        s,
        'failed',
        { code, step: failing?.key ?? null, retryable: kindOf(s.row.kind)?.retry ?? false },
        null,
      );
    });
  }

  private async close(
    s: State,
    status: 'succeeded' | 'failed' | 'cancelled',
    error: { code: string; step: string | null; retryable: boolean } | null,
    result: OperationResult | null,
  ) {
    const now = this.ctx.clock.now();
    const keep =
      s.row.audience === 'starter'
        ? null
        : now + (status === 'failed' ? KEEP_MS.failed : KEEP_MS.ended);
    const current = s.steps.find((x) => x.state === 'failed')?.key ?? s.row.step_key;
    await finish(this.ctx.env.DB, {
      id: this.id,
      attempt: s.row.attempt,
      now,
      status,
      steps: JSON.stringify(s.steps),
      stepKey: current,
      error,
      result,
      expiresAt: keep,
      lease: this.lease ?? '',
    });
    this.dead = true;
  }
}

/**
 * How work reports. `attempt` is required: it is the attempt this runner serves, and an old Workflow instance
 * of a retried operation passes its own, so its writes are refused (put it in the Workflow params beside
 * `operationId`). `lease` is the token `operation.run` handed the hook; it keeps a twin runner from extending
 * the lease. With no `opId` (a start that predates this, a test) every call does nothing.
 */
export function progressOf(
  ctx: ServiceContext,
  opId: string | undefined,
  attempt: number,
  lease?: Writer,
): Progress {
  return opId ? new Reporter(ctx, opId, attempt, lease ?? null) : NOOP;
}
