import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORG_KIND, registerTestKinds } from '../modules/operations/operations-test-fixtures.ts';
import { rowById } from '../modules/operations/repo.ts';
import { startOperation } from '../modules/operations/start.ts';
import { type Kit, setupKit } from '../modules/passes/pass-test-fixtures.ts';
import { checkTerminalFailures } from '../modules/status/checks-health.ts';
import { checkHooks } from '../modules/status/checks-hooks.ts';
import { recordHookOutcomes } from '../modules/status/hook-health.ts';
import { all } from '../platform/db.ts';
import type { AppEnv } from '../platform/env.ts';
import { handleQueue } from './queue.ts';
import { DLQ_QUEUE } from './retry.ts';

let kit: Kit;
let undo: () => void;
beforeEach(async () => {
  kit = await setupKit();
  undo = registerTestKinds({ run: async () => {} });
});
afterEach(() => undo());

const dead = (body: unknown, id = 'dm1') => {
  const m = {
    id,
    body,
    attempts: 1,
    acked: false,
    ack: () => {
      m.acked = true;
    },
    retry: () => {},
  };
  return m;
};
const drain = (m: ReturnType<typeof dead>) =>
  handleQueue(
    { queue: DLQ_QUEUE, messages: [m] } as unknown as MessageBatch<unknown>,
    kit.env as AppEnv,
    createExecutionContext(),
  );

describe('dead-letter terminal outcome', () => {
  it('fails the operation of a dropped operation.run and keeps the drop for Status', async () => {
    const op = await startOperation(kit.ctx, {
      kind: ORG_KIND.kind,
      org: { orgId: kit.org.id, mode: 'live' },
      actor: { type: 'user', id: 'u1' },
      subject: { k: 'dlq' },
    });
    const m = dead({ kind: 'operation.run', operationId: op.id, attempt: 1 });
    await drain(m);
    expect(m.acked).toBe(true);
    const row = await rowById(kit.env.DB, op.id);
    expect(row).toMatchObject({ status: 'failed', error_code: 'DEAD_LETTER' });
    const kept = await all<{ job_kind: string; target_id: string | null }>(
      kit.env.DB,
      'SELECT job_kind, target_id FROM dlq_outcomes',
    );
    expect(kept).toEqual([{ job_kind: 'operation.run', target_id: op.id }]);
    const status = await checkTerminalFailures(kit.ctx);
    expect(status.state).toBe('degraded');
    expect(status.data).toMatchObject({ 'dropped_operation.run': 1 });
    // A redelivered drop changes nothing.
    await drain(dead({ kind: 'operation.run', operationId: op.id, attempt: 1 }));
    expect(await all(kit.env.DB, 'SELECT 1 FROM dlq_outcomes')).toHaveLength(1);
  });
});

describe('hook health', () => {
  it('keeps last success and last failure per hook and flags a failing one', async () => {
    expect((await checkHooks(kit.ctx)).state).toBe('configured');
    await recordHookOutcomes(kit.ctx, 'cron', [{ hook: 'a.hook', failure: null }]);
    expect((await checkHooks(kit.ctx)).state).toBe('verified');
    kit.clock.advance(1000);
    await recordHookOutcomes(kit.ctx, 'cron', [{ hook: 'a.hook', failure: 'CRON_HOOK_FAILED' }]);
    const s = await checkHooks(kit.ctx);
    expect(s.state).toBe('degraded');
    expect(s.data).toMatchObject({ failing: 1 });
    expect(String(s.data?.['cron:a.hook'])).toContain('CRON_HOOK_FAILED');
    kit.clock.advance(1000);
    await recordHookOutcomes(kit.ctx, 'cron', [{ hook: 'a.hook', failure: null }]);
    expect((await checkHooks(kit.ctx)).state).toBe('verified');
  });
});
