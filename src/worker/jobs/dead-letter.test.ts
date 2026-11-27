import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORG_KIND, registerTestKinds } from '../modules/operations/operations-test-fixtures.ts';
import { rowById } from '../modules/operations/repo.ts';
import { startOperation } from '../modules/operations/start.ts';
import { type Kit, setupKit } from '../modules/passes/pass-test-fixtures.ts';
import { checkTerminalFailures } from '../modules/status/checks-health.ts';
import { loadHooks, withHooks } from '../modules/status/checks-hooks.ts';
import { checkCron } from '../modules/status/cron-check.ts';
import { recordHookOutcomes } from '../modules/status/hook-health.ts';
import { pruneDlqOutcomes, recordDlqOutcome } from '../modules/status/repo-hooks.ts';
import { all } from '../platform/db.ts';
import type { AppEnv } from '../platform/env.ts';
import { handleQueue } from './queue.ts';
import { DLQ_QUEUE } from './retry.ts';

let kit: Kit;
let undo: () => void;
beforeEach(async () => {
  kit = await setupKit();
  await kit.env.DB.batch([
    kit.env.DB.prepare('DELETE FROM dlq_outcomes'),
    kit.env.DB.prepare('DELETE FROM hook_health'),
  ]);
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

describe('old drops', () => {
  it('no longer degrade Status after 30 days, and the daily hook prunes them', async () => {
    await recordDlqOutcome(kit.env.DB, {
      messageId: 'dm-old',
      jobKind: 'push.deliver',
      orgId: null,
      targetId: null,
      code: 'DEAD_LETTER',
      at: kit.clock.now(),
    });
    expect((await checkTerminalFailures(kit.ctx)).state).toBe('degraded');
    kit.clock.advance(31 * 86_400_000);
    expect((await checkTerminalFailures(kit.ctx)).state).toBe('verified');
    await pruneDlqOutcomes(kit.env.DB, kit.clock.now());
    expect(await all(kit.env.DB, 'SELECT 1 FROM dlq_outcomes')).toHaveLength(0);
  });

  it('keeps an invalid message as an outcome with a code and no payload', async () => {
    await drain(dead({ nonsense: 'secret-payload' }, 'dm-bad'));
    const rows = await all<Record<string, unknown>>(kit.env.DB, 'SELECT * FROM dlq_outcomes');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_kind: 'invalid', code: 'INVALID_MESSAGE' });
    expect(JSON.stringify(rows)).not.toContain('secret-payload');
  });
});

describe('hook health', () => {
  const cronRow = async () => (await checkCron(kit.ctx)).find((c) => c.id === 'cron:minute');
  it('shows each hook on its cron row and degrades it when the last run failed', async () => {
    await recordHookOutcomes(kit.ctx, 'minute', [{ hook: 'a.hook', failure: null }]);
    expect((await cronRow())?.data).toHaveProperty('a.hook');
    kit.clock.advance(1000);
    await recordHookOutcomes(kit.ctx, 'minute', [{ hook: 'a.hook', failure: 'CRON_HOOK_FAILED' }]);
    const bad = await cronRow();
    expect(bad?.state).toBe('degraded');
    expect(String(bad?.data?.['a.hook'])).toContain('CRON_HOOK_FAILED');
    kit.clock.advance(1000);
    await recordHookOutcomes(kit.ctx, 'minute', [{ hook: 'a.hook', failure: null }]);
    expect((await cronRow())?.detail ?? '').not.toContain('failing');
  });

  it('lists queue kinds under the job queue row', async () => {
    await recordHookOutcomes(kit.ctx, 'queue', [{ hook: 'push.deliver', failure: 'JOB_FAILED' }]);
    const queue = withHooks({ state: 'verified', detail: null }, await loadHooks(kit.ctx), 'queue');
    expect(queue.state).toBe('degraded');
  });
});
