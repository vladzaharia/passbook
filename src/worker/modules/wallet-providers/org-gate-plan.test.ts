// MT4a: the org's plan is a layer of the provider gate: release, then the plan (not_included), then enrolment.
import { afterEach, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { first, run } from '../../platform/db.ts';
import { passChannels } from '../channels/service.ts';
import { getVersion } from '../templates/repo.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { computeProjectionPins } from './projection-pins.ts';
import { createProjectionCandidate } from './projection-service.ts';
import {
  setWalletProvidersEnabledForTest,
  walletEnrolmentIssuesSql,
  walletProviderDisabledReason,
} from './provider-policy.ts';

const testEnv = installKeysetTestEnv();
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

async function kitOf(google: 'absent' | 'configured') {
  const f = await setupWalletOfferKit({ google, samsung: 'absent', db: (await testEnv()).DB });
  restore = setWalletProvidersEnabledForTest(true);
  const db = f.kit.env.DB;
  // Every sold plan includes Google: 'trial' here means a plan without it, a Google override of 0.
  const plan = async (preset: string) => {
    await run(db, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [
      preset,
      f.kit.org.id,
    ]);
    await run(
      db,
      "DELETE FROM org_entitlement_overrides WHERE org_id = ? AND key = 'wallet.google'",
      [f.kit.org.id],
    );
    if (preset === 'trial')
      await run(
        db,
        "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'wallet.google', '0', 1)",
        [f.kit.org.id],
      );
  };
  const reason = (provider: 'google' | 'samsung' = 'google') =>
    walletProviderDisabledReason(db, provider, f.kit.org.id, 'live');
  const open = async () =>
    (
      await first<{ ok: number }>(
        db,
        `SELECT ${walletEnrolmentIssuesSql('q.org_id', 'q.mode', 'q.provider')} AS ok
         FROM (SELECT ? AS org_id, 'live' AS mode, 'google' AS provider) q`,
        [f.kit.org.id],
      )
    )?.ok;
  const effective = async () => (await passChannels(f.kit.ctx, f.pass)).effective;
  return { f, plan, reason, open, effective };
}

describe('the plan layer of the provider gate', () => {
  it('leaves an enrolled legacy org as it was', async () => {
    const { reason, open, effective } = await kitOf('configured');
    expect(await reason()).toBeNull();
    expect(await open()).toBe(1);
    expect((await effective()).google.reason).toBeUndefined();
  });

  it('closes an enrolled org when the plan drops the wallet: the reason, the SQL gate and the channel', async () => {
    const { plan, reason, open, effective } = await kitOf('configured');
    await plan('trial');
    expect(await reason()).toBe('not_included');
    expect(await reason('samsung')).toBe('not_included');
    expect(await open()).toBe(0);
    expect((await effective()).google).toEqual({
      on: false,
      source: 'platform',
      reason: 'not_included',
    });
    await plan('legacy');
    expect(await reason()).toBeNull();
    expect(await open()).toBe(1);
    expect((await effective()).google.reason).toBeUndefined();
  });

  it('names the plan before the missing enrolment, and the enrolment once the plan includes it', async () => {
    const { plan, reason, effective } = await kitOf('absent');
    expect(await reason()).toBe('not_enrolled');
    await plan('trial');
    expect(await reason()).toBe('not_included');
    expect((await effective()).google.reason).toBe('not_included');
    await plan('standard');
    expect(await reason()).toBe('not_enrolled');
    expect((await effective()).google).toMatchObject({ source: 'org', reason: 'not_enrolled' });
  });

  it('keeps the platform release first', async () => {
    const { plan, reason } = await kitOf('configured');
    await plan('trial');
    const undo = setWalletProvidersEnabledForTest(false);
    expect(await reason()).toBe('not_released');
    undo();
  });

  it('reads an override over the preset, and fails closed on a value that is not a flag', async () => {
    const { f, plan, reason, open } = await kitOf('configured');
    await plan('trial');
    const override = (value: string) =>
      run(
        f.kit.env.DB,
        `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
         VALUES (?, 'wallet.google', ?, 1)`,
        [f.kit.org.id, value],
      );
    await override('1');
    expect(await reason()).toBeNull();
    expect(await reason('samsung')).toBe('not_included');
    expect(await open()).toBe(1);
    await override('7');
    expect(await reason()).toBe('not_included');
    expect(await open()).toBe(0);
  });

  it('answers a projection create for a plan without the wallet with 403, not a retry conflict (review L5)', async () => {
    const { f, plan } = await kitOf('configured');
    const { kit, apple } = f;
    const version = await getVersion(kit.env.DB, kit.template.id, kit.template.version);
    if (!version) throw new Error('Offer fixture version is missing.');
    const { pins } = await computeProjectionPins(kit.ctx, 'google', version);
    const create = () =>
      createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
        orgId: kit.org.id,
        mode: 'live',
        provider: 'google',
        version: kit.template.version,
        sourceReleaseId: apple.id,
        projection: { schema: 2, provider: 'google', approvedOmissions: pins.approvedOmissions },
      });
    await plan('trial');
    await expect(create()).rejects.toMatchObject({
      status: 403,
      code: 'FEATURE_NOT_INCLUDED',
      feature: 'wallet.google',
    });
    await plan('legacy');
    await expect(create()).resolves.toMatchObject({ provider: 'google' });
  });
});
