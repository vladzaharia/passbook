import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../../platform/clock.ts';
import { first } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import {
  saveOrgCredential,
  savePlatformCredential,
} from '../wallet-providers/credential-service.ts';
import {
  CHECK_JOB,
  granted,
  uid,
} from '../wallet-providers/repo-wallet-credentials-test-fixtures.ts';
import { type Kit, kit } from '../wallet-providers/wallet-wa1b-test-fixtures.ts';
import { checkWalletCredentials } from './checks-wallet.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

const now = () => Date.now();
const statusOf = async (at = now()) =>
  checkWalletCredentials(createServiceContext(k.env, { clock: new ManualClock(at) }));

async function record(credentialId: string, ok: 0 | 1, code: string | null) {
  const v = await first<{ v: string }>(
    env.DB,
    'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
    [credentialId],
  );
  await granted(CHECK_JOB, [
    env.DB.prepare(
      'INSERT INTO wallet_credential_checks (id, credential_id, version_id, ok, code) VALUES (?, ?, ?, ?, ?)',
    ).bind(uid(), credentialId, v?.v, ok, code),
  ]);
}

describe('wallet credential status', () => {
  it('reads each credential from its newest check', async () => {
    expect((await statusOf())[0]).toMatchObject({ state: 'not_in_use', detail: 'No credentials.' });

    const admin = await k.admin();
    const platform = await savePlatformCredential(k.ctx, admin.auth, {
      provider: 'google',
      mode: 'live',
      expectedRevision: 0,
      credentials: k.google(),
    });
    let rows = await statusOf();
    expect(rows[0]).toMatchObject({ state: 'configured', data: { total: 1, unchecked: 1 } });
    expect(rows[1]).toMatchObject({
      id: `wallet-credential:${platform.id}`,
      detail: 'Not checked yet.',
    });

    await record(platform.id, 0, 'auth_failed');
    rows = await statusOf();
    expect(rows[0]).toMatchObject({ state: 'failing', data: { failing: 1 } });
    expect(rows[1]?.detail).toBe('Check failed: the provider refused the key.');

    await record(platform.id, 1, 'cert_expiring');
    rows = await statusOf();
    expect(rows[0]?.state).toBe('degraded');
    expect(rows[1]?.detail).toBe('Certificate expires within 30 days.');

    await record(platform.id, 1, null);
    expect((await statusOf())[0]).toMatchObject({ state: 'verified', detail: null });
    expect(await statusOf()).toHaveLength(1);
    expect((await statusOf(now() + 3 * 86_400_000))[0]).toMatchObject({ state: 'degraded' });
  });

  it('an org credential that fails degrades the platform instead of failing it', async () => {
    const org = await k.org();
    const { auth } = await k.member(org.id);
    const saved = await saveOrgCredential(k.ctx, auth, org.id, {
      provider: 'google',
      expectedRevision: 0,
      credentials: k.google('987654321'),
    });
    await record(saved.id, 0, 'issuer_not_found');
    const rows = await statusOf();
    const row = rows.find((r) => r.id === `wallet-credential:${saved.id}`);
    expect(row).toMatchObject({ state: 'degraded', data: { orgId: org.id, scope: 'org' } });
    expect(row?.detail).toBe('Check failed: the issuer was not found.');
  });
});
