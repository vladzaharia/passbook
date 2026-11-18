import { describe, expect, it, vi } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { runJob } from '../../jobs/registry.ts';
import { all } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';

const state = vi.hoisted(() => ({ pending: true }));
vi.mock('../delivery/repo-issuance-recovery.ts', async (original) => ({
  ...(await original<object>()),
  hasPendingIssuanceTransfer: async () => state.pending,
}));

describe('the lost-phone mail job', () => {
  it('waits while the transfer is pending, then sends once on retry', async () => {
    const kit = await setupKit();
    const user = await makeUser(kit.fx);
    const pass = await kit.pass({ holderEmail: user.primaryEmail });
    const mails = () =>
      all(kit.env.DB, "SELECT id FROM outbox WHERE pass_id = ? AND kind = 'email'", [pass.id]);
    const job = {
      kind: 'pass.holder_mail',
      passId: pass.id,
      userId: pass.ownerUserId,
      reason: 'lost_phone',
    } as const;
    state.pending = true;
    await expect(runJob(job, jobCtxOf(kit))).rejects.toMatchObject({
      code: 'HOLDER_TRANSFER_PENDING',
    });
    expect(await mails()).toHaveLength(0);
    state.pending = false;
    await runJob(job, jobCtxOf(kit));
    expect(await mails()).toHaveLength(1);
  });
});
