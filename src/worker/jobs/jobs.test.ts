import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { makeEnv } from '../../../test/helpers/index.ts';
import { resetBakedSync, syncBakedTemplates } from '../modules/templates/sync.ts';
import { first } from '../platform/db.ts';
import type { AppEnv } from '../platform/env.ts';
import { createServiceContext } from '../platform/service-context.ts';
import { CRON_HOOKS, DAILY_CRON, handleScheduled, MINUTE_CRON } from './cron.ts';
import { CRON_QUERY_BUDGET } from './query-counter.ts';
import { handleQueue } from './queue.ts';
import { JOB_HANDLERS } from './registry.ts';
import { DLQ_QUEUE, JOBS_QUEUE, retryDelaySeconds } from './retry.ts';
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

  it('defers the rest of a batch once the estimated D1 query budget is spent', async () => {
    const original = JOB_HANDLERS['connection.webhook'];
    const ran: string[] = [];
    JOB_HANDLERS['connection.webhook'] = async (job) => {
      ran.push(job.eventId);
    };
    const full = (eventId: string) =>
      message({
        kind: 'connection.webhook',
        connectionId: 'c1',
        eventId,
        refs: Array.from({ length: 20 }, (_, i) => `r${i}`),
      });
    // A full webhook job estimates 530 queries: one fits in the 800 budget, not two.
    const messages = ['a', 'b', 'c'].map(full);
    try {
      await handleQueue(batch(JOBS_QUEUE, messages), env as AppEnv, createExecutionContext());
    } finally {
      JOB_HANDLERS['connection.webhook'] = original;
    }
    expect(ran).toEqual(['a']);
    expect(messages.map((m) => m.acked)).toEqual([true, false, false]);
    expect(messages[1]?.retried).toEqual({ delaySeconds: 5 });
    expect(messages[2]?.retried).toEqual({ delaySeconds: 5 });
  });

  it('runs a whole batch of small jobs and always runs the first message', async () => {
    const original = JOB_HANDLERS['push.deliver'];
    const ran: string[] = [];
    JOB_HANDLERS['push.deliver'] = async (job) => {
      ran.push(job.outboxId);
    };
    const small = ['a', 'b', 'c'].map((outboxId) => message({ kind: 'push.deliver', outboxId }));
    const over = ['x', 'y'].map((outboxId) => message({ kind: 'push.deliver', outboxId }));
    try {
      await handleQueue(batch(JOBS_QUEUE, small), env as AppEnv, createExecutionContext());
      await handleQueue(batch(JOBS_QUEUE, over), env as AppEnv, createExecutionContext(), 0);
    } finally {
      JOB_HANDLERS['push.deliver'] = original;
    }
    expect(ran).toEqual(['a', 'b', 'c', 'x']);
    expect(small.every((m) => m.acked)).toBe(true);
    expect(over[1]?.retried).toEqual({ delaySeconds: 5 });
  });

  it('acks dead letters', async () => {
    const dead = message({ kind: 'push.deliver', outboxId: 'o1' });
    await handleQueue(batch(DLQ_QUEUE, [dead]), env as AppEnv, createExecutionContext());
    expect(dead.acked).toBe(true);
  });
});

describe('dead-letter consumer', () => {
  const failing = async (attempts: number) => {
    const dead = message({ kind: 'push.deliver', outboxId: 'o1' }, attempts);
    const bad = { ...env, DB: undefined } as unknown as AppEnv;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleQueue(batch(DLQ_QUEUE, [dead]), bad, createExecutionContext());
      return { dead, logged: error.mock.calls.map((call) => String(call[0])) };
    } finally {
      error.mockRestore();
    }
  };

  it('retries a failing message before the third attempt', async () => {
    const { dead, logged } = await failing(2);
    expect(dead.retried).toEqual({ delaySeconds: 300 });
    expect(logged.some((l) => l.includes('queue.dlq_failed') && l.includes('code'))).toBe(true);
  });

  it('logs queue.dlq_dropped with a code and acks on the third attempt', async () => {
    const { dead, logged } = await failing(3);
    expect(dead.acked).toBe(true);
    const line = logged.find((l) => l.includes('queue.dlq_dropped'));
    expect(line).toContain('"code"');
    expect(line).toContain('push.deliver');
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
    expect(CRON_HOOKS[DAILY_CRON]?.map((h) => h.name)).toContain('identities.apns_probe');
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

  it('skips daily hooks once the query budget is spent', async () => {
    const hooks = CRON_HOOKS[DAILY_CRON] ?? [];
    const original = hooks.splice(0, hooks.length);
    const ran: string[] = [];
    hooks.push(
      {
        name: 'heavy',
        run: async (ctx) => {
          ran.push('heavy');
          for (let i = 0; i < CRON_QUERY_BUDGET; i++) await ctx.env.DB.prepare('SELECT 1').first();
        },
      },
      { name: 'late', run: async () => void ran.push('late') },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await handleScheduled(controller(DAILY_CRON), env as AppEnv, createExecutionContext());
      expect(ran).toEqual(['heavy']);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('cron.budget_skipped'))).toBe(true);
    } finally {
      hooks.splice(0, hooks.length, ...original);
      warn.mockRestore();
    }
  });
});

describe('baked template sync', () => {
  it('runs on the minute cron so the first template request copies nothing', async () => {
    resetBakedSync();
    const appEnv = await makeEnv();
    const ctx = createExecutionContext();
    await handleScheduled(
      {
        cron: MINUTE_CRON,
        scheduledTime: Date.now(),
        type: 'scheduled',
        noRetry() {},
      } as unknown as ScheduledController,
      appEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(
      await first<{ value: string }>(
        env.DB,
        "SELECT value FROM settings WHERE scope = 'system' AND key = 'templates.baked_hash'",
      ),
    ).not.toBeNull();
    resetBakedSync();
    const puts = vi.spyOn(appEnv.BUCKET, 'put');
    await syncBakedTemplates(createServiceContext(appEnv));
    expect(puts).not.toHaveBeenCalled();
  });
});
