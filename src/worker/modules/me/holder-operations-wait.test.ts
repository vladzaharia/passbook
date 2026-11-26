import { describe, expect, it, vi } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { runJob } from '../../jobs/registry.ts';
import type { Job } from '../../jobs/types.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { toDto } from '../operations/dto.ts';
import { rowById } from '../operations/repo.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { startHolderOperation } from './operations-start.ts';

const state = vi.hoisted(() => ({ pending: true }));
vi.mock('../delivery/repo-issuance-recovery.ts', async (original) => ({
  ...(await original<object>()),
  hasPendingIssuanceTransfer: async () => state.pending,
}));

async function setup() {
  const kit = await setupKit();
  const sent: { job: Job; delaySeconds: number | undefined }[] = [];
  kit.env.JOBS = {
    send: vi.fn(async (job: Job, options?: { delaySeconds?: number }) => {
      sent.push({ job, delaySeconds: options?.delaySeconds });
    }),
    sendBatch: vi.fn(),
  } as unknown as Queue;
  const user = await makeUser(kit.fx);
  const pass = await kit.pass({ holderEmail: user.primaryEmail });
  const who = { userId: user.id, sessionId: 'session-hash' };
  const op = (id: string) => rowById(kit.env.DB, id).then((row) => toDto(row as never));
  return { kit, sent, pass, who, op };
}

describe('a removal waits for the wallets', () => {
  it('looks again later while a transfer is pending, then ends done', async () => {
    const { kit, sent, pass, who, op } = await setup();
    const started = await startHolderOperation(jobCtxOf(kit), who, 'holder.remove', pass.id);
    await started.progress.step('account').done();
    await started.progress.waiting('wallets', { reason: 'Waiting for your wallets' });
    const run: Job = { kind: 'operation.run', operationId: started.id, attempt: 1 };
    state.pending = true;
    await runJob(run, jobCtxOf(kit));
    const waiting = await op(started.id);
    expect(waiting.status).toBe('waiting');
    expect(waiting.text).toBe('Waiting for your wallets');
    // The next look is its own queued job with a delay, not a wait inside this one.
    expect(sent.at(-1)).toMatchObject({ job: run, delaySeconds: expect.any(Number) });
    expect(sent.at(-1)?.delaySeconds).toBeGreaterThanOrEqual(30);
    state.pending = false;
    await runJob(run, jobCtxOf(kit));
    const done = await op(started.id);
    expect(done).toMatchObject({ status: 'succeeded', text: 'Pass removed' });
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done']);
    expect(JSON.stringify(done)).not.toContain('@');
  });
});

describe('a lost phone waits for the wallets, then sends the new pass', () => {
  it('shows the wait on the wallets step and carries on when the transfer ends', async () => {
    const { kit, pass, who, op } = await setup();
    const started = await startHolderOperation(jobCtxOf(kit), who, 'holder.lost_phone', pass.id);
    await started.progress.step('rotate').done();
    await started.progress.step('signout').done();
    await started.progress.waiting('wallets', { reason: 'Waiting for your wallets' });
    const mail: Job = {
      kind: 'pass.holder_mail',
      passId: pass.id,
      userId: pass.ownerUserId,
      reason: 'lost_phone',
      operationId: started.id,
    };
    state.pending = true;
    await expect(runJob(mail, jobCtxOf(kit))).rejects.toMatchObject({
      code: 'HOLDER_TRANSFER_PENDING',
    });
    const waiting = await op(started.id);
    expect(waiting).toMatchObject({ status: 'waiting', step: 'wallets' });
    expect(waiting.steps.find((s) => s.key === 'wallets')).toMatchObject({
      state: 'waiting',
      detail: 'Waiting for your wallets',
    });
    state.pending = false;
    await runJob(mail, jobCtxOf(kit));
    const done = await op(started.id);
    expect(done.status).toBe('succeeded');
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done']);
  });
});
