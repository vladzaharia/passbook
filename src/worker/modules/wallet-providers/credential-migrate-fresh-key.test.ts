// WA1d: the 0112 fresh-key trigger lets only the migrate job and a migration resolution put a key on a legacy
// row; and the runtime fence of a new-model row is its enrolment_revision.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { first, stmt } from '../../platform/db.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { seedLegacy } from './credential-migrate-test-fixtures.ts';
import { saveOrgCredential } from './credential-service.ts';
import { setEnrolmentSource } from './enrolment-service.ts';
import { findAccount } from './repo-accounts.ts';
import { bytes, granted } from './repo-wallet-credentials-test-fixtures.ts';
import { type Kit, kit } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

const setKey = (id: string) =>
  stmt(
    env.DB,
    `UPDATE wallet_provider_accounts SET hmac_kek_version = 1, hmac_iv = ?, hmac_wrapped_dek = ?, hmac_ciphertext = ?
     WHERE id = ?`,
    [bytes(12), bytes(60), bytes(48), id],
  );
const hasKey = async (id: string) =>
  (
    await first<{ k: number }>(
      env.DB,
      'SELECT hmac_ciphertext IS NOT NULL AS k FROM wallet_provider_accounts WHERE id = ?',
      [id],
    )
  )?.k;

describe('wallet_provider_accounts_hmac_fresh', () => {
  it('refuses a key on a legacy row for every writer but the migrate job and a resolution', async () => {
    const org = await k.org();
    const a = await seedLegacy(k, org.id, 'live', 'google', k.google('830100100'));
    const re = /without a legacy envelope/;
    const base = { orgId: org.id, mode: 'live' as const };
    // No grant, then the org's own writers: source, enable, revoke, and a platform hold.
    await expect(setKey(a.id).run()).rejects.toThrow(re);
    for (const [purpose, principal] of [
      ['org_mode.wallet.enrolment_source', 'membership:m1'],
      ['org_mode.wallet.enrolment_enable', 'membership:m1'],
      ['org_mode.wallet.enrolment_revoke', 'membership:m1'],
      ['org_mode.wallet.enrolment_hold', 'platform:u1'],
      ['org_mode.job.wallet.enrolment_hold', 'system:wallet-job'],
    ] as const)
      await expect(
        granted({ ...base, purpose, principal }, [setKey(a.id)]),
        purpose,
      ).rejects.toThrow(re);
    // The migrate grant of another org does not reach this row.
    await expect(
      granted(
        {
          orgId: (await k.org()).id,
          mode: 'live',
          purpose: 'org_mode.job.wallet.credential_migrate',
          principal: 'system:wallet-job',
        },
        [setKey(a.id)],
      ),
    ).rejects.toThrow(re);
    expect(await hasKey(a.id)).toBe(0);
    await granted(
      {
        ...base,
        purpose: 'org_mode.job.wallet.credential_migrate',
        principal: 'system:wallet-job',
      },
      [setKey(a.id)],
    );
    expect(await hasKey(a.id)).toBe(1);
    const b = await seedLegacy(k, org.id, 'test', 'google', k.google('830200200'));
    await granted(
      {
        orgId: org.id,
        mode: 'test',
        purpose: 'org_mode.wallet.migration_resolve',
        principal: 'platform:u1',
      },
      [setKey(b.id)],
    );
    expect(await hasKey(b.id)).toBe(1);
  });
});

describe('the runtime fence of a new-model row', () => {
  it('is its enrolment_revision, not the unused legacy revision', async () => {
    const org = await k.org();
    const m = await k.member(org.id, 'test');
    await saveOrgCredential(k.ctx, m.auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('840100100'),
    });
    await setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
      source: 'org',
      expectedRevision: 0,
    });
    const scope = { orgId: org.id, mode: 'test' as const, provider: 'google' as const };
    await ensureCredentialRefKeyset(env.DB, k.env);
    const raw = await first<{ revision: number; enrolment_revision: number }>(
      env.DB,
      'SELECT revision, enrolment_revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = ?',
      [org.id, 'test'],
    );
    expect(raw).toEqual({ revision: 0, enrolment_revision: 1 });
    expect((await findAccount(env.DB, scope))?.revision).toBe(1);
    expect((await getWalletProviderReadiness(k.ctx, scope)).revision).toBe(1);
  });
});
