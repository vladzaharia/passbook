// MT4a review M1: enabling an enrolment needs the plan's wallet, before any prerequisite, in both modes.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { savePlatformCredential } from './credential-service.ts';
import { disableEnrolment, enableEnrolment, setEnrolmentSource } from './enrolment-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';
import { type Kit, kit, type Mode } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
  setWalletProvidersEnabledForTest(true);
}, 30_000);

const platform = new Map<Mode, Promise<{ id: string; versionId: string }>>();
function platformSource(mode: Mode) {
  let hit = platform.get(mode);
  if (!hit) {
    hit = (async () => {
      const admin = await k.admin(mode);
      const saved = await savePlatformCredential(k.ctx, admin.auth, {
        mode,
        provider: 'google',
        expectedRevision: 0,
        credentials: k.google('777000444'),
      });
      const version = await first<{ v: string }>(
        env.DB,
        'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
        [saved.id],
      );
      return { id: saved.id, versionId: version?.v ?? '' };
    })();
    platform.set(mode, hit);
  }
  return hit;
}

/** An org with a platform source chosen and a fresh check: only the plan (and Live's round trip) can stop the enable. */
async function ready(mode: Mode, preset: string) {
  const cred = await platformSource(mode);
  const org = await k.org();
  await run(env.DB, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [preset, org.id]);
  // Every sold plan includes Google, so "the plan lacks the wallet" is a Google override of 0 on the lowest.
  if (preset === 'trial')
    await run(
      env.DB,
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'wallet.google', '0', 1)",
      [org.id],
    );
  const m = await k.member(org.id, mode);
  await setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
    source: 'platform',
    expectedRevision: 0,
  });
  await addCheck(cred.id, cred.versionId);
  return { org, m };
}
const notIncluded = { status: 403, code: 'FEATURE_NOT_INCLUDED', feature: 'wallet.google' };
const enabledAt = (orgId: string, mode: Mode) =>
  first<{ enabled_at: number | null }>(
    env.DB,
    "SELECT enabled_at FROM wallet_provider_accounts WHERE org_id = ? AND mode = ? AND provider = 'google'",
    [orgId, mode],
  ).then((r) => r?.enabled_at ?? null);

describe('enabling a wallet enrolment under the plan', () => {
  it('refuses in Test with FEATURE_NOT_INCLUDED and writes nothing', async () => {
    const { org, m } = await ready('test', 'trial');
    await expect(
      enableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 1 }),
    ).rejects.toMatchObject(notIncluded);
    expect(await enabledAt(org.id, 'test')).toBeNull();
  });

  it('refuses in Live with the plan, not the round_trip prerequisite', async () => {
    const { org, m } = await ready('live', 'trial');
    await expect(
      enableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 1 }),
    ).rejects.toMatchObject(notIncluded);
  });

  it('enables once the plan includes the wallet, and disable stays open under a downgrade', async () => {
    const { org, m } = await ready('test', 'trial');
    await run(
      env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, 'wallet.google', '1', 1)`,
      [org.id],
    );
    await enableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 1 });
    expect(await enabledAt(org.id, 'test')).not.toBeNull();
    await run(env.DB, 'DELETE FROM org_entitlement_overrides WHERE org_id = ?', [org.id]);
    await disableEnrolment(k.ctx, m.auth, org.id, 'google', { expectedRevision: 2 });
    expect(await enabledAt(org.id, 'test')).toBeNull();
  });
});
