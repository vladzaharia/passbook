// PE5d: wallet_provider_instances.retirement_settled_at (0148). The view stays the one definition of
// "settled"; the column is set once by trigger and read everywhere else.
import { beforeAll, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { withoutTrigger } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { runtimeGoogleLegacyFixture } from './runtime-integration-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
const makeEnv = installKeysetTestEnv();

type Row = {
  provider: string;
  credential_generation: number;
  lifecycle: string;
  retired_at: number | null;
  retirement_settled_at: number | null;
};
const rows = (db: D1Database, passId: string) =>
  all<Row>(
    db,
    `SELECT provider, credential_generation, lifecycle, retired_at, retirement_settled_at
     FROM wallet_provider_instances WHERE pass_id = ? ORDER BY credential_generation, provider`,
    [passId],
  );

describe('retirement_settled_at', () => {
  it('is set when a not-issued placeholder retires, and not before', async () => {
    const kit = await setupKit({ db: (await makeEnv()).DB });
    const db = kit.env.DB;
    const pass = await kit.pass({ holderEmail: 'a@example.test' });
    for (const email of ['b@example.test', 'c@example.test']) {
      const holder = await getHolderPass(db, pass.id, null);
      if (!holder) throw new Error('Missing holder snapshot');
      expect(
        await startCredentialTransfer(
          jobCtxOf(kit),
          { type: 'system', id: null },
          pass.id,
          { holderEmail: email, ownerUserId: null },
          null,
          { kind: 'tenant-holder', expected: holder },
        ),
      ).toMatchObject({ state: 'completed' });
    }
    const all3 = await rows(db, pass.id);
    const retired = all3.filter((r) => r.lifecycle === 'retired');
    const live = all3.filter((r) => r.lifecycle !== 'retired');
    expect(retired.length).toBeGreaterThan(0);
    // The generation_advance trigger retires the placeholders with an UPDATE; settle fires on it.
    for (const r of retired) {
      expect(r.retirement_settled_at).not.toBeNull();
      expect(r.retirement_settled_at).toBe(r.retired_at);
    }
    for (const r of live) expect(r.retirement_settled_at).toBeNull();
  });

  it('stays NULL for an issued Google instance, which cannot retire yet', async () => {
    const f = await runtimeGoogleLegacyFixture({ db: (await makeEnv()).DB });
    const db = f.kit.env.DB;
    const now = f.kit.clock.now();
    // The fixture's instance is issued and revoking. 0043 refuses to retire an issued Google object until
    // CW9b adds its replay guarantee, so the view and the column stay empty.
    await run(db, "UPDATE wallet_provider_instances SET lifecycle = 'revoked' WHERE id = ?", [
      f.instanceId,
    ]);
    await expect(
      run(
        db,
        "UPDATE wallet_provider_instances SET lifecycle = 'retired', retired_at = ? WHERE id = ?",
        [now, f.instanceId],
      ),
    ).rejects.toThrow();
    expect(
      await first(
        db,
        'SELECT lifecycle, retirement_settled_at FROM wallet_provider_instances WHERE id = ?',
        [f.instanceId],
      ),
    ).toEqual({ lifecycle: 'revoked', retirement_settled_at: null });
  });

  it('cannot be forged, inserted or rewritten', async () => {
    const f = await runtimeGoogleLegacyFixture({ db: (await makeEnv()).DB });
    const db = f.kit.env.DB;
    await expect(
      run(db, 'UPDATE wallet_provider_instances SET retirement_settled_at = 1 WHERE id = ?', [
        f.instanceId,
      ]),
    ).rejects.toThrow(/provider retirement is not settled/);
    await expect(
      withoutTrigger(db, 'wallet_provider_generation_insert_guard', () =>
        run(
          db,
          `INSERT INTO wallet_provider_instances
          (id, pass_id, org_id, mode, provider, credential_generation, credential_keyset_commitment,
           lifecycle, desired_version, created_at, updated_at, retirement_settled_at)
         SELECT ?, pass_id, org_id, mode, provider, credential_generation + 7, credential_keyset_commitment,
           'blocked', 0, created_at, updated_at, 5 FROM wallet_provider_instances WHERE id = ?`,
          [crypto.randomUUID(), f.instanceId],
        ),
      ),
    ).rejects.toThrow(/provider retirement is not settled/);
  });
});
