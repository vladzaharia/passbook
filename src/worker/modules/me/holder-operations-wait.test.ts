import { describe, expect, it, vi } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { runJob } from '../../jobs/registry.ts';
import type { Job } from '../../jobs/types.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { toDto } from '../operations/dto.ts';
import { rowById } from '../operations/repo.ts';
import { sweepStalledOperations } from '../operations/stalls.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { waitOnWallets } from './operations.ts';
import { startHolderOperation } from './operations-start.ts';

const state = vi.hoisted(() => ({ pending: true, own: true }));
vi.mock('../delivery/repo-issuance-recovery.ts', async (original) => ({
  ...(await original<object>()),
  hasPendingIssuanceTransfer: async () => state.pending,
}));
vi.mock('./repo.ts', async (original) => ({
  ...(await original<object>()),
  hasPendingOwnRemoval: async () => state.own,
}));

const HOUR = 3_600_000;

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

/** A removal that has done its first steps and waits for the wallets, as the request leaves it. */
async function waitingRemoval(s: Awaited<ReturnType<typeof setup>>) {
  const started = await startHolderOperation(jobCtxOf(s.kit), s.who, 'holder.remove', s.pass.id);
  await started.progress.step('account').done();
  await waitOnWallets(started.progress, s.kit.clock.now());
  return started;
}

describe('a removal waits for the wallets', () => {
  it('looks again later while its transfer is pending, then ends done', async () => {
    const s = await setup();
    const started = await waitingRemoval(s);
    const run: Job = { kind: 'operation.run', operationId: started.id, attempt: 1 };
    state.own = true;
    await runJob(run, jobCtxOf(s.kit));
    const waiting = await s.op(started.id);
    expect(waiting.status).toBe('waiting');
    // A timed wait that ends at the cap: "By <date>", never open-ended.
    expect(waiting.steps[1]).toMatchObject({ state: 'waiting', waitingReason: 'due' });
    expect(waiting.steps[1]?.until).toBe(waiting.createdAt + 24 * HOUR);
    expect(s.sent.at(-1)).toMatchObject({ job: run, delaySeconds: expect.any(Number) });
    expect(s.sent.at(-1)?.delaySeconds).toBeGreaterThanOrEqual(30);
    state.own = false;
    await runJob(run, jobCtxOf(s.kit));
    const done = await s.op(started.id);
    expect(done).toMatchObject({ status: 'succeeded', text: 'Pass removed' });
    expect(JSON.stringify(done)).not.toContain('@');
  });

  it('is not held by another transfer that starts on the pass later', async () => {
    const s = await setup();
    const started = await waitingRemoval(s);
    // Its own transfer is done; somebody else's is pending on the same pass.
    state.own = false;
    state.pending = true;
    await runJob({ kind: 'operation.run', operationId: started.id, attempt: 1 }, jobCtxOf(s.kit));
    expect((await s.op(started.id)).status).toBe('succeeded');
  });

  it('a lost look ends failed, never waiting for ever', async () => {
    const s = await setup();
    const started = await waitingRemoval(s);
    state.own = true;
    // The queue lost the message: nothing is queued. Past the cap and the grace, the sweep resends once...
    s.kit.clock.advance(25 * HOUR);
    await sweepStalledOperations(jobCtxOf(s.kit));
    const resent = s.sent.find(
      (x) => x.job.kind === 'operation.run' && x.job.operationId === started.id,
    );
    expect(resent).toBeDefined();
    // ...and that look finds the cap passed and ends it with words saying what to do.
    await runJob(resent?.job as Job, jobCtxOf(s.kit));
    const failed = await s.op(started.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatchObject({ code: 'HOLDER_TRANSFER_PENDING', retryable: false });
    expect(failed.error?.message).toMatch(/Try again|later/i);
  });

  it('sends the look before it writes the wait: a failed send leaves no wait', async () => {
    const s = await setup();
    s.kit.env.JOBS = {
      send: vi.fn(async () => {
        throw new Error('queue down');
      }),
      sendBatch: vi.fn(),
    } as unknown as Queue;
    const { removeMyPass } = await import('./service-actions.ts');
    const user = s.who.userId;
    await expect(
      removeMyPass(jobCtxOf(s.kit), user, 'session-hash', s.pass.id, {
        requestRefresh: vi.fn() as never,
        removePassFromUser: async () => ({ transferId: 't1', state: 'pending' as const }),
      }),
    ).rejects.toThrow('queue down');
    const row = await s.kit.env.DB.prepare(
      "SELECT status FROM operations WHERE kind = 'holder.remove' AND target_id = ?",
    )
      .bind(s.pass.id)
      .first<{ status: string }>();
    expect(row?.status).toBe('failed');
  });
});

describe('a lost phone waits for the wallets, then sends the new pass', () => {
  async function waitingLost(s: Awaited<ReturnType<typeof setup>>) {
    const started = await startHolderOperation(
      jobCtxOf(s.kit),
      s.who,
      'holder.lost_phone',
      s.pass.id,
    );
    await started.progress.step('rotate').done();
    await started.progress.step('signout').done();
    await waitOnWallets(started.progress, s.kit.clock.now());
    return started;
  }

  it('a runner waits for the transfer and then queues the mail once', async () => {
    const s = await setup();
    const started = await waitingLost(s);
    const run: Job = { kind: 'operation.run', operationId: started.id, attempt: 1 };
    state.pending = true;
    await runJob(run, jobCtxOf(s.kit));
    expect((await s.op(started.id)).status).toBe('waiting');
    expect(s.sent.filter((x) => x.job.kind === 'pass.holder_mail')).toHaveLength(0);
    state.pending = false;
    await runJob(run, jobCtxOf(s.kit));
    const mails = s.sent.filter((x) => x.job.kind === 'pass.holder_mail');
    expect(mails).toHaveLength(1);
    // The mail job runs without waiting on queue retries and ends the operation.
    await runJob(mails[0]?.job as Job, jobCtxOf(s.kit));
    const done = await s.op(started.id);
    expect(done.status).toBe('succeeded');
    expect(done.steps.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done']);
    // A resent look after the mail went out sends nothing more.
    await runJob(run, jobCtxOf(s.kit));
    expect(s.sent.filter((x) => x.job.kind === 'pass.holder_mail')).toHaveLength(1);
  });

  it('a lost look ends failed, and the mail is never promised', async () => {
    const s = await setup();
    const started = await waitingLost(s);
    state.pending = true;
    s.kit.clock.advance(25 * HOUR);
    await sweepStalledOperations(jobCtxOf(s.kit));
    const resent = s.sent.find(
      (x) => x.job.kind === 'operation.run' && x.job.operationId === started.id,
    );
    await runJob(resent?.job as Job, jobCtxOf(s.kit));
    const failed = await s.op(started.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('HOLDER_TRANSFER_PENDING');
    expect(s.sent.filter((x) => x.job.kind === 'pass.holder_mail')).toHaveLength(0);
  });
});
