import type { OperationKindDef } from '../../../shared/operations/define.ts';
import {
  sandboxCreate,
  sandboxDelete,
  sandboxRecreate,
  sandboxReset,
} from '../../../shared/operations/kinds/sandbox.ts';
import type { LocalOperationDef } from './local.ts';
import { stepText } from './text.ts';
import type { Operation, OperationStatus, OperationStep } from './types.ts';

// The sandbox kinds' words live in src/shared/operations/kinds/sandbox.ts: the fixtures draw from them.
const fromKind = (kind: OperationKindDef): LocalOperationDef => ({
  kind: kind.kind,
  title: kind.title,
  doneTitle: kind.doneTitle,
  failTitle: kind.failTitle,
  steps: kind.steps.map((s) => ({
    key: s.key,
    label: s.label,
    ...(s.active ? { active: s.active } : {}),
    ...(s.group ? { group: s.group } : {}),
  })),
});

export const SANDBOX_CREATE = fromKind(sandboxCreate);
export const SANDBOX_DELETE = fromKind(sandboxDelete);
export const SANDBOX_RESET = fromKind(sandboxReset);
export const SANDBOX_RECREATE = fromKind(sandboxRecreate);

/** A step that waits on someone else: the waiting state. */
export const APPLE_SETUP: LocalOperationDef = {
  kind: 'identity.provision',
  title: 'Set up Apple ID',
  doneTitle: 'Apple ID ready',
  failTitle: 'Could not set up Apple ID',
  steps: [
    { key: 'load', label: 'Check account', active: 'Checking the account' },
    { key: 'issue', label: 'Issue certificate', active: 'Issuing the certificate' },
    { key: 'validate', label: 'Validate it', active: 'Validating the certificate' },
  ],
};

export const NOW = Date.UTC(2026, 10, 25, 22, 14, 0);
export const DEC_2 = Date.UTC(2026, 11, 2, 20, 0, 0);

export interface FixtureOptions {
  status: OperationStatus;
  /** The step that runs, waits or fails. */
  at?: string;
  /** Counts for the step at `at`. */
  counts?: { done: number; total: number };
  /** A step that stays waiting after the others are done (the erase tail). */
  tail?: boolean;
  /** Steps that wait on a date while the rest runs (the old sandbox's erase). */
  tails?: readonly string[];
  /** Waiting: when it resumes. */
  until?: number;
  error?: string;
  cancelable?: boolean;
  startedAgoMs?: number;
  tookMs?: number;
  id?: string;
}

/** An operation in any state, from a kind's copy. Steps before `at` are done, after it pending. */
export function fixtureOperation(def: LocalOperationDef, o: FixtureOptions): Operation {
  const at = o.at ?? def.steps[0]?.key;
  const index = def.steps.findIndex((s) => s.key === at);
  const ended = o.status === 'succeeded';
  const started = NOW - (o.startedAgoMs ?? 18_000);
  const steps: OperationStep[] = def.steps.map((s, i) => {
    const base = {
      key: s.key,
      label: s.label,
      done: null,
      total: null,
      detail: null,
      until: null,
      waitingReason: null,
      group: 'group' in s ? (s.group ?? null) : null,
      startedAt: null,
      finishedAt: null,
    };
    const last = i === def.steps.length - 1;
    if (ended)
      return o.tail && last
        ? { ...base, state: 'waiting', until: DEC_2, waitingReason: 'due' }
        : { ...base, state: 'done', startedAt: started, finishedAt: NOW };
    if (o.status === 'queued') return { ...base, state: 'pending' };
    if (o.tails?.includes(s.key))
      return { ...base, state: 'waiting', until: DEC_2, waitingReason: 'due' };
    if (o.status === 'cancelled' && i >= index)
      return { ...base, state: 'skipped', ...(i === index ? (o.counts ?? {}) : {}) };
    if (i < index) return { ...base, state: 'done', startedAt: started, finishedAt: NOW };
    if (i === index) {
      const state =
        o.status === 'failed' ? 'failed' : o.status === 'waiting' ? 'waiting' : 'running';
      return {
        ...base,
        state: o.status === 'cancelled' ? 'done' : state,
        startedAt: started,
        until: o.status === 'waiting' ? (o.until ?? NOW + 6 * 3_600_000) : null,
        waitingReason: o.status === 'waiting' ? 'blocked' : null,
        ...(o.counts ?? {}),
      };
    }
    return { ...base, state: 'pending' };
  });
  const cur = steps[index];
  const active =
    def.steps[index] && 'active' in def.steps[index] ? def.steps[index].active : undefined;
  const text =
    o.status === 'queued'
      ? 'Starting'
      : o.status === 'succeeded'
        ? (def.doneTitle ?? def.title)
        : o.status === 'failed'
          ? (def.failTitle ?? `Could not ${def.title.toLowerCase()}`)
          : o.status === 'waiting'
            ? 'Waiting for Apple'
            : o.status === 'cancelled'
              ? 'Stopped'
              : cur
                ? stepText(cur, active)
                : def.title;
  return {
    id: o.id ?? `op-${def.kind}-${o.status}`,
    kind: def.kind,
    status: o.status,
    title: def.title,
    text,
    orgId: null,
    mode: null,
    target: { type: 'sandbox', id: 'org-1' },
    step: ended || o.status === 'queued' ? null : (at ?? null),
    steps,
    attempt: 1,
    cancelable: o.cancelable ?? o.status === 'running',
    cancelRequested: false,
    startedBy: { type: 'user', id: null },
    createdAt: started,
    startedAt: o.status === 'queued' ? null : started,
    updatedAt: NOW,
    finishedAt:
      ended || o.status === 'failed' || o.status === 'cancelled'
        ? ended
          ? started + (o.tookMs ?? 72_000)
          : NOW
        : null,
    error:
      o.status === 'failed'
        ? {
            code: 'OPERATION_FAILED',
            message: o.error ?? 'Webhooks are off on this plan. Retry.',
            step: at ?? null,
            retryable: true,
          }
        : null,
    result: ended ? { href: null, ids: {} } : null,
    revision: 3,
    pollAfterMs: 1000,
  };
}

/** Every state of the design's §3.3 table, from the sandbox copy. */
export const STATE_FIXTURES = {
  queued: () => fixtureOperation(SANDBOX_CREATE, { status: 'queued' }),
  running: () =>
    fixtureOperation(SANDBOX_DELETE, {
      status: 'running',
      at: 'passes',
      counts: { done: 4, total: 12 },
      startedAgoMs: 18_000,
    }),
  runningNoCount: () =>
    fixtureOperation(SANDBOX_CREATE, { status: 'running', at: 'template', cancelable: false }),
  waiting: () => fixtureOperation(APPLE_SETUP, { status: 'waiting', at: 'issue' }),
  succeeded: () =>
    fixtureOperation(SANDBOX_DELETE, { status: 'succeeded', tail: true, tookMs: 72_000 }),
  failed: () => fixtureOperation(SANDBOX_CREATE, { status: 'failed', at: 'capture' }),
  cancelled: () =>
    fixtureOperation(SANDBOX_DELETE, {
      status: 'cancelled',
      at: 'passes',
      counts: { done: 4, total: 12 },
    }),
  recreate: () =>
    fixtureOperation(SANDBOX_RECREATE, {
      status: 'running',
      at: 'org',
      tails: ['erase'],
      startedAgoMs: 7_000,
    }),
} as const;
export type StateFixture = keyof typeof STATE_FIXTURES;
