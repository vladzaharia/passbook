// WA5: the per-org layer of the provider gate. Release first, then the org's enrolment in the mode.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { configureWalletProviderAccount } from './account-service.ts';
import { savePlatformCredential } from './credential-service.ts';
import { holdEnrolment } from './enrolment-hold.ts';
import { disableEnrolment, enableEnrolment, setEnrolmentSource } from './enrolment-service.ts';
import {
  setWalletProvidersEnabledForTest,
  walletEnrolmentIssuesSql,
  walletProviderDisabledReason,
} from './provider-policy.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';
import { type Kit, kit, type Mode } from './wallet-wa1b-test-fixtures.ts';

let k: Kit;
beforeAll(async () => {
  k = await kit();
}, 30_000);

const reason = (orgId: string, mode: Mode, provider: 'google' | 'samsung' = 'google') =>
  walletProviderDisabledReason(env.DB, provider, orgId, mode);

const sqlOpen = async (orgId: string, mode: Mode) =>
  (await first<{ ok: number }>(
    env.DB,
    `SELECT ${walletEnrolmentIssuesSql('q.org_id', 'q.mode', 'q.provider')} AS ok
     FROM (SELECT ? AS org_id, ? AS mode, 'google' AS provider) q`,
    [orgId, mode],
  )) ?? null;

/** One platform credential per mode, shared by every org's enrolment. */
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
        credentials: k.google('777000333'),
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

async function source(mode: Mode) {
  const cred = await platformSource(mode);
  const org = await k.org();
  const m = await k.member(org.id, mode);
  await setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
    source: 'platform',
    expectedRevision: 0,
  });
  return { org, m, credentialId: cred.id, versionId: cred.versionId };
}

describe('the org layer', () => {
  it('stays not_released while the platform has not released, enrolled or not', async () => {
    const e = await source('test');
    expect(await reason(e.org.id, 'test')).toBe('not_released');
  });

  describe('with the platform released', () => {
    beforeAll(() => {
      setWalletProvidersEnabledForTest(true);
    });

    it('refuses an org with no enrolment, and a source that is still Off', async () => {
      const org = await k.org();
      expect(await reason(org.id, 'live')).toBe('not_enrolled');
      expect(await reason(org.id, 'live', 'samsung')).toBe('not_enrolled');
      const e = await source('test');
      expect(await reason(e.org.id, 'test')).toBe('not_enrolled');
      expect(await reason(e.org.id, 'live')).toBe('not_enrolled');
    });

    it('opens when On, closes on Off and on a platform hold, per mode', async () => {
      const e = await source('test');
      await addCheck(e.credentialId, e.versionId);
      await enableEnrolment(k.ctx, e.m.auth, e.org.id, 'google', { expectedRevision: 1 });
      expect(await reason(e.org.id, 'test')).toBeNull();
      expect((await sqlOpen(e.org.id, 'test'))?.ok).toBe(1);
      // Live is a separate enrolment: Test being On opens nothing in Live.
      expect(await reason(e.org.id, 'live')).toBe('not_enrolled');
      expect((await sqlOpen(e.org.id, 'live'))?.ok).toBe(0);
      await disableEnrolment(k.ctx, e.m.auth, e.org.id, 'google', { expectedRevision: 2 });
      expect(await reason(e.org.id, 'test')).toBe('not_enrolled');
      expect((await sqlOpen(e.org.id, 'test'))?.ok).toBe(0);
    });

    it('closes on a platform hold', async () => {
      const e = await source('test');
      await addCheck(e.credentialId, e.versionId);
      await enableEnrolment(k.ctx, e.m.auth, e.org.id, 'google', { expectedRevision: 1 });
      const admin = await k.admin();
      await holdEnrolment(
        k.ctx,
        admin.auth,
        { orgId: e.org.id, mode: 'test', provider: 'google' },
        'abuse',
      );
      expect(await reason(e.org.id, 'test')).toBe('not_enrolled');
      expect((await sqlOpen(e.org.id, 'test'))?.ok).toBe(0);
    });

    it('keeps Live behind the Test round trip', async () => {
      const e = await source('live');
      await addCheck(e.credentialId, e.versionId);
      await expect(
        enableEnrolment(k.ctx, e.m.auth, e.org.id, 'google', { expectedRevision: 1 }),
      ).rejects.toMatchObject({ code: 'WALLET_ENROLMENT_PREREQUISITE' });
      expect(await reason(e.org.id, 'live')).toBe('not_enrolled');
    });

    it('reads the release per mode before the enrolment', async () => {
      const org = await k.org();
      const undo = setWalletProvidersEnabledForTest(false, 'live');
      expect(await reason(org.id, 'live')).toBe('not_released');
      expect(await reason(org.id, 'test')).toBe('not_enrolled');
      undo();
    });

    // 0226: the legacy branch is gone. An envelope with no enrolment On never issues.
    it('refuses a legacy envelope row with no enrolment', async () => {
      const org = await k.org();
      const m = await k.member(org.id, 'live');
      await configureWalletProviderAccount(k.ctx, m.auth, {
        orgId: org.id,
        mode: 'live',
        provider: 'google',
        expectedRevision: 0,
        credentials: k.google('888000001'),
      });
      expect(await reason(org.id, 'live')).toBe('not_enrolled');
      expect((await sqlOpen(org.id, 'live'))?.ok).toBe(0);
    });
  });

  it('rejects an untrusted identifier in the SQL form', () => {
    expect(() => walletEnrolmentIssuesSql('p.org_id; --', 'p.mode', 'p.provider')).toThrow();
  });
});
