import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { makeEnv } from '../../../test/helpers/index.ts';
import * as holderTransferJobs from '../modules/holders/transfer-jobs.ts';
import { ensureCredentialRefKeyset } from '../modules/passes/credential-keyset.ts';
import * as credentialTransfer from '../modules/passes/credential-transfer-resume.ts';
import { resetBakedSync, syncBakedTemplates } from '../modules/templates/sync.ts';
import { loadKekRing } from '../platform/crypto.ts';
import { first } from '../platform/db.ts';
import type { AppEnv } from '../platform/env.ts';
import { createServiceContext } from '../platform/service-context.ts';
import { CRON_HOOKS, DAILY_CRON, handleScheduled, MINUTE_CRON } from './cron.ts';
import { CRON_QUERY_BUDGET, countQueries } from './query-counter.ts';
import { handleQueue } from './queue.ts';
import { JOB_HANDLERS } from './registry.ts';
import { DLQ_QUEUE, JOBS_QUEUE, retryDelaySeconds } from './retry.ts';
import { JobSchema, type NewConnectionWebhookJob } from './types.ts';

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

describe('query-counted environment', () => {
  it('exposes inherited encryption bindings while preserving counted D1 access', async () => {
    const original = await makeEnv();
    const wrapped = Object.create(original) as AppEnv;
    const counter = countQueries(wrapped);
    expect(Object.hasOwn(counter.env, 'KEK_V1')).toBe(true);
    expect((await loadKekRing(counter.env)).keys.has(1)).toBe(true);
    expect(await first(counter.env.DB, 'SELECT 1 AS n')).toEqual({ n: 1 });
    expect(counter.count()).toBe(1);
  });
});

describe('job router', () => {
  it('declares a handler for every job kind', () => {
    const kinds = JobSchema.options.map((o) => o.shape.kind.value).sort();
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual(kinds);
  });

  it('decodes legacy webhook jobs without inventing a commitment', () => {
    const current: NewConnectionWebhookJob = {
      kind: 'connection.webhook',
      connectionId: 'c1',
      orgId: 'o1',
      generation: 1,
      credentialKeysetCommitment: 'a'.repeat(64),
      eventId: 'e1',
      refs: ['r1'],
    };
    expect(JobSchema.safeParse(current).success).toBe(true);
    const { credentialKeysetCommitment: _omitted, ...legacy } = current;
    const parsed = JobSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === 'connection.webhook')
      expect(parsed.data.credentialKeysetCommitment).toBeUndefined();
    expect(JobSchema.safeParse({ ...current, credentialKeysetCommitment: 'invalid' }).success).toBe(
      false,
    );
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

  it('acknowledges legacy or malformed refresh epochs without dispatching', async () => {
    const refresh = {
      kind: 'pass.refresh',
      passId: 'p1',
      orgId: 'o1',
      identityId: 'i1',
      mode: 'live',
      templateId: 't1',
      templateVersion: '1',
      releaseId: null,
      passVersion: 1,
      status: 'active',
      ownerUserId: null,
      linkGeneration: 1,
      credentialGeneration: 2,
      lifecycleGeneration: 0,
      credentialKeysetCommitment: 'a'.repeat(64),
      connectionId: null,
      externalRef: null,
      generation: null,
      connectionMode: null,
      trigger: 'user',
      actorId: 'u1',
    };
    const invalid = [
      { ...refresh, credentialGeneration: undefined },
      { ...refresh, lifecycleGeneration: undefined },
      { ...refresh, identityId: undefined },
      { ...refresh, connectionMode: undefined },
      { ...refresh, connectionMode: 'invalid' },
      { ...refresh, templateId: undefined },
      { ...refresh, templateVersion: undefined },
      { ...refresh, releaseId: undefined },
      { ...refresh, credentialKeysetCommitment: undefined },
      { ...refresh, credentialKeysetCommitment: 'invalid' },
      { ...refresh, credentialGeneration: 0 },
      { ...refresh, credentialGeneration: 1.5 },
      { ...refresh, lifecycleGeneration: -1 },
      { ...refresh, lifecycleGeneration: '0' },
    ].map((body) => message(body));
    const valid = message(refresh);
    const original = JOB_HANDLERS['pass.refresh'];
    const dispatched = vi.fn(async () => {});
    JOB_HANDLERS['pass.refresh'] = dispatched;
    try {
      await handleQueue(
        batch(JOBS_QUEUE, [...invalid, valid]),
        env as AppEnv,
        createExecutionContext(),
      );
    } finally {
      JOB_HANDLERS['pass.refresh'] = original;
    }
    expect(invalid.every((m) => m.acked && m.retried === null)).toBe(true);
    expect(valid.acked).toBe(true);
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveBeenCalledWith(refresh, expect.anything());
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
        orgId: 'org1',
        generation: 1,
        eventId,
        refs: Array.from({ length: 20 }, (_, i) => `r${i}`),
      });
    // A full webhook job estimates 700 queries: one fits in the 800 budget, not two.
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
    expect(CRON_HOOKS[MINUTE_CRON]?.map((h) => h.name)).toContain('wallet.sync');
    expect(CRON_HOOKS[MINUTE_CRON]?.map((h) => h.name)).toContain('passes.credential_transfers');
    const appEnv = await makeEnv();
    await ensureCredentialRefKeyset(appEnv.DB, appEnv);
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

  it('finishes transfers before retrying attachments and retries after either sweep fails', async () => {
    const appEnv = await makeEnv();
    const hook = CRON_HOOKS[MINUTE_CRON]?.find((h) => h.name === 'passes.credential_transfers');
    if (!hook) throw new Error('missing credential transfer hook');
    const events: string[] = [];
    const finish = vi
      .spyOn(credentialTransfer, 'resumePendingCredentialTransfers')
      .mockImplementation(async () => {
        events.push('finish');
      });
    const attach = vi
      .spyOn(holderTransferJobs, 'resumeVerifiedHolderAttachments')
      .mockImplementation(async () => {
        events.push('attach');
      });
    const ctx = createServiceContext(appEnv);
    try {
      finish.mockRejectedValueOnce(new Error('finish failed'));
      await expect(hook.run(ctx)).rejects.toThrow('finish failed');
      expect(attach).not.toHaveBeenCalled();

      attach.mockRejectedValueOnce(new Error('attach failed'));
      await expect(hook.run(ctx)).rejects.toThrow('attach failed');
      await hook.run(ctx);
      expect(events).toEqual(['finish', 'finish', 'attach']);
      expect(finish).toHaveBeenCalledTimes(3);
      expect(attach).toHaveBeenCalledTimes(2);
    } finally {
      finish.mockRestore();
      attach.mockRestore();
    }
  });

  it('retries transfers after wallet sync on each minute, isolating failures', async () => {
    const appEnv = await makeEnv();
    const hooks = CRON_HOOKS[MINUTE_CRON] ?? [];
    const original = hooks.splice(0, hooks.length);
    const events: string[] = [];
    let minute = 0;
    let retired = false;
    let completed = false;
    hooks.push(
      {
        name: 'wallet.sync',
        run: async () => {
          events.push(`wallet:${minute}`);
          await Promise.resolve();
          if (minute === 2) throw new Error('wallet unavailable');
          if (minute === 3) retired = true;
          events.push(`wallet-done:${minute}`);
        },
      },
      {
        name: 'passes.credential_transfers',
        run: async () => {
          events.push(`transfer:${minute}`);
          if (minute === 2) throw new Error('transfer unavailable');
          if (retired) completed = true;
        },
      },
      { name: 'other', run: async () => void events.push(`other:${minute}`) },
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (minute = 1; minute <= 3; minute++) {
        await handleScheduled(controller(MINUTE_CRON), appEnv, createExecutionContext());
        expect(completed).toBe(minute === 3);
      }
      for (const n of [1, 2, 3]) {
        expect(events).toContain(`other:${n}`);
        expect(events.indexOf(`transfer:${n}`)).toBeGreaterThan(events.indexOf(`wallet:${n}`));
      }
      expect(events.indexOf('transfer:3')).toBeGreaterThan(events.indexOf('wallet-done:3'));
      const failures = error.mock.calls.map((call) => String(call[0]));
      expect(failures.filter((line) => line.includes('cron.hook_failed'))).toHaveLength(2);
      expect(failures.some((line) => line.includes('wallet.sync'))).toBe(true);
      expect(failures.some((line) => line.includes('passes.credential_transfers'))).toBe(true);
    } finally {
      hooks.splice(0, hooks.length, ...original);
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
