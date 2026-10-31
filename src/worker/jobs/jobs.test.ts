import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
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
  it('has hooks for both schedules and tolerates them all', async () => {
    expect(CRON_HOOKS[MINUTE_CRON]?.length).toBeGreaterThan(0);
    expect(CRON_HOOKS[DAILY_CRON]?.length).toBeGreaterThan(0);
    for (const cron of [MINUTE_CRON, DAILY_CRON, 'unknown']) {
      await handleScheduled(
        {
          cron,
          scheduledTime: Date.now(),
          type: 'scheduled',
          noRetry() {},
        } as unknown as ScheduledController,
        env as AppEnv,
        createExecutionContext(),
      );
    }
  });
});
