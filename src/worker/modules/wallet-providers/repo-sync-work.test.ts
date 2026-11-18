import { beforeAll, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { replaceKeysetForTest } from '../connections/runtime-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { walletSyncHasWork } from './repo-sync-work.ts';
import { drainWalletProviderSync } from './sync.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

const makeEnv = installKeysetTestEnv();

function recording(ctx: ServiceContext) {
  const errors: unknown[][] = [];
  const log = { ...ctx.log, error: (...args: unknown[]) => void errors.push(args) };
  return { ctx: { ...ctx, log } as ServiceContext, errors };
}

describe('wallet sync without a keyset', () => {
  it('has no work, requires no keyset and logs nothing on an empty database', async () => {
    const env = await makeEnv();
    const { ctx, errors } = recording({
      env,
      clock: { now: () => 1_000_000 },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ServiceContext);
    expect(await walletSyncHasWork(env.DB, 1_000_000)).toBe(false);
    await drainWalletProviderSync(ctx);
    expect(errors).toEqual([]);
  });

  it('fails closed and logs the code once when work is queued and the keyset is missing', async () => {
    const kit = await setupKit({ db: (await makeEnv()).DB });
    const pass = await kit.pass({ holderEmail: 'before@example.test' });
    const db = kit.env.DB;
    const expected = await getHolderPass(db, pass.id, null);
    if (!expected) throw new Error('Missing holder snapshot');
    await startCredentialTransfer(
      jobCtxOf(kit),
      { type: 'system', id: null },
      pass.id,
      { holderEmail: 'after@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected },
    );
    const instance = await first<{ id: string }>(
      db,
      "SELECT id FROM wallet_provider_instances WHERE pass_id = ? AND lifecycle = 'ready' LIMIT 1",
      [pass.id],
    );
    if (!instance) throw new Error('Missing provider placeholder');
    await run(
      db,
      `INSERT INTO wallet_provider_instance_dirty (instance_id, generation, next_attempt_at)
      VALUES (?, 1, 0) ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1`,
      [instance.id],
    );
    expect(await walletSyncHasWork(db, kit.clock.now())).toBe(true);
    await replaceKeysetForTest(jobCtxOf(kit), null);
    const { ctx, errors } = recording(jobCtxOf(kit));
    await drainWalletProviderSync(ctx);
    expect(errors).toEqual([
      ['wallet.sync_keyset_unavailable', { code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' }],
    ]);
  });
});
