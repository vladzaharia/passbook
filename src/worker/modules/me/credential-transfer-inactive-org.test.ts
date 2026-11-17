import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { atOwnerWrite } from '../holders/fixed-barcode-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { removePassFromUser } from '../holders/service-remove.ts';
import { ownerSessionId } from '../holders/test-auth-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { finishCredentialTransfer } from '../passes/credential-transfer.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  newWalletClaimHandle,
} from '../wallet-providers/instance.ts';
import { reconcileWalletInstance } from '../wallet-providers/lifecycle.ts';
import { makeProviderTestTemplate } from '../wallet-providers/offers-test-fixtures.ts';
import { finishWalletProviderRetirement } from '../wallet-providers/sync-operation-retirement.ts';

const makeEnv = installKeysetTestEnv();

describe('a self-remove transfer and an org suspended mid-way', () => {
  it('refuses FINISH in a suspended org and leaves the transfer pending', async () => {
    const kit = await setupKit({ db: (await makeEnv()).DB, template: makeProviderTestTemplate });
    const user = await makeUser(kit.fx);
    const apple = await approveAppleRelease(kit);
    const pass = await kit.pass({ holderEmail: user.primaryEmail });
    const t = await setupSamsungCallbacks({ source: { kit, apple, pass, barcode: 'none' } });
    const session = await ownerSessionId(kit, user.id);
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing pass');
    const started = await removePassFromUser(kit.ctx, pass.id, user.id, session);
    if (!started.transferId || started.state !== 'pending') throw new Error('Not pending');

    const scope = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
    };
    const old = await getWalletInstanceById(kit.env.DB, scope);
    if (!old) throw new Error('Missing wallet incarnation');
    expect(await reconcileWalletInstance(jobCtxOf(kit), old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(kit.env.DB, scope);
    if (!retiring) throw new Error('Missing retiring incarnation');
    const claim = {
      ...scope,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: kit.clock.now(),
    };
    expect(await claimWalletOperation(kit.env.DB, claim)).toBe('claimed');
    await completeWalletOperation(jobCtxOf(kit), {
      ...claim,
      result: { kind: 'success', httpStatus: 200 },
    });
    expect(await finishWalletProviderRetirement(jobCtxOf(kit), claim)).toBe(true);
    // The org is read active while the FINISH is built; it is suspended just before the batch commits.
    const race = atOwnerWrite(kit, () =>
      run(kit.env.DB, 'UPDATE orgs SET status = ? WHERE id = ?', ['suspended', pass.orgId]),
    );
    await expect(
      finishCredentialTransfer(race.ctx, started.transferId, {
        kind: 'self-remove',
        expected,
        userId: user.id,
        sessionId: session,
      }),
    ).rejects.toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
    expect(race.fired()).toBe(true);
    const row = await first<{ state: string }>(
      kit.env.DB,
      'SELECT state FROM pass_credential_transfers WHERE id = ?',
      [started.transferId],
    );
    expect(row?.state).not.toBe('completed');
    expect((await getPass(kit.env.DB, pass.id))?.ownerUserId).toBe(user.id);
  }, 120_000);
});
