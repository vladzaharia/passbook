import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { makeEnv } from '../../../test/helpers/index.ts';
import type { AppEnv } from '../platform/env.ts';
import { CRON_HOOKS, DAILY_CRON, handleScheduled, MINUTE_CRON } from './cron.ts';
import { DLQ_QUEUE, handleQueue, JOBS_QUEUE, retryDelaySeconds } from './queue.ts';
import { JOB_HANDLERS } from './registry.ts';
import { JobSchema } from './types.ts';

interface FakeMessage {
  id: string;
  body: unknown;
  attempts: number;
  acked: boolean;
  retried: { delaySeconds?: number } | null;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

function message(body: unknown, attempts = 1): FakeMessage {
  const m: FakeMessage = {
    id: 'm1',
    body,
    attempts,
    acked: false,
    retried: null,
    ack: () => {
      m.acked = true;
    },
    retry: (options) => {
      m.retried = options ?? {};
    },
  };
  return m;
}

const batch = (queue: string, messages: FakeMessage[]) =>
  ({ queue, messages }) as unknown as MessageBatch<unknown>;

describe('job router', () => {
  it('declares a handler for every job kind', () => {
    const kinds = JobSchema.options.map((o) => o.shape.kind.value).sort();
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual(kinds);
  });

  it('backs off exponentially up to an hour', () => {
    expect([1, 2, 3, 20].map(retryDelaySeconds)).toEqual([30, 60, 120, 3600]);
  });

  it('acks invalid messages and retries failing handlers with backoff', async () => {
    const bad = message({ kind: 'nope' });
    const stub = message({ kind: 'push.deliver', outboxId: 'o1' }, 3);
    const original = JOB_HANDLERS['push.deliver'];
    JOB_HANDLERS['push.deliver'] = async () => {
      throw new Error('boom');
    };
    try {
      await handleQueue(batch(JOBS_QUEUE, [bad, stub]), env as AppEnv, createExecutionContext());
    } finally {
      JOB_HANDLERS['push.deliver'] = original;
    }
    expect(bad.acked).toBe(true);
    expect(stub.acked).toBe(false);
    expect(stub.retried).toEqual({ delaySeconds: 120 });
  });

  it('acks dead letters', async () => {
    const dead = message({ kind: 'push.deliver', outboxId: 'o1' });
    await handleQueue(batch(DLQ_QUEUE, [dead]), env as AppEnv, createExecutionContext());
    expect(dead.acked).toBe(true);
  });
});

describe('cron dispatcher', () => {
  const controller = (cron: string) =>
    ({
      cron,
      scheduledTime: Date.now(),
      type: 'scheduled',
      noRetry() {},
    }) as unknown as ScheduledController;

  it('runs every hook of both schedules without a logged failure', async () => {
    expect(CRON_HOOKS[MINUTE_CRON]?.length).toBeGreaterThan(0);
    expect(CRON_HOOKS[DAILY_CRON]?.length).toBeGreaterThan(0);
    const appEnv = await makeEnv();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const cron of [MINUTE_CRON, DAILY_CRON, 'unknown']) {
        const ctx = createExecutionContext();
        await handleScheduled(controller(cron), appEnv, ctx);
        await waitOnExecutionContext(ctx);
      }
      const logged = error.mock.calls.map((call) => String(call[0]));
      expect(logged.filter((l) => /cron\.(hook|record)_failed/.test(l))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('logs a failing hook instead of throwing', async () => {
    const hooks = CRON_HOOKS[MINUTE_CRON] ?? [];
    const original = hooks[0];
    if (!original) throw new Error('no minute hook');
    hooks[0] = {
      name: original.name,
      run: async () => {
        throw new Error('boom');
      },
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleScheduled(controller(MINUTE_CRON), env as AppEnv, createExecutionContext());
      expect(error.mock.calls.some((call) => String(call[0]).includes('cron.hook_failed'))).toBe(
        true,
      );
    } finally {
      hooks[0] = original;
      error.mockRestore();
    }
  });
});
