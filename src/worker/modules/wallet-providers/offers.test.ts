import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeOrg, persistTemplate } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { fakeLimiter } from '../auth/test-support.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { reassignHolder } from '../holders/service.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { rotateLink } from '../passes/pass-service-delivery.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { revokeWalletProviderAccount } from './account-service.ts';
import { issueWalletOffer, listWalletOffers, redeemSamsungOffer } from './offers.ts';
import { eligibleWalletProvider, offerPassSnapshot } from './offers-eligibility.ts';
import {
  type OfferFixtureState,
  setupWalletOfferKit as setupOfferFixture,
} from './offers-test-fixtures.ts';

import { createProjectionCandidate, getApprovedProjection } from './projection-service.ts';

const testEnv = installKeysetTestEnv();

async function setupWalletOfferKit(options: Parameters<typeof setupOfferFixture>[0] = {}) {
  return setupOfferFixture({ ...options, db: (await testEnv()).DB });
}

const unavailable = async (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ status: 403, code: 'WALLET_PROVIDER_DISABLED' });

async function expectNoCapabilities(db: D1Database) {
  for (const table of [
    'wallet_provider_instances',
    'wallet_provider_offer_refs',
    'wallet_samsung_fetch_refs',
    'wallet_google_callback_bindings',
  ]) {
    expect(await all(db, `SELECT 1 FROM ${table}`)).toEqual([]);
  }
}

async function approvedSamsung(
  ctx: ServiceContext,
  pass: Pass,
  credentialKeysetCommitment: string,
) {
  if (!pass.releaseId) throw new Error('Missing approved Apple source in fixture.');
  return getApprovedProjection(
    ctx,
    {
      orgId: pass.orgId,
      mode: pass.mode,
      provider: 'samsung',
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      appleReleaseId: pass.releaseId,
    },
    { credentialKeysetCommitment },
  );
}

describe('native wallet availability', () => {
  it('uses a reviewed source supported by both providers without accepting extra Apple semantics', async () => {
    const f = await setupWalletOfferKit({ samsung: 'configured' });

    for (const provider of ['google', 'samsung'] as const) {
      const projection = f.projection(provider);
      const candidate = await createProjectionCandidate(
        f.kit.ctx,
        f.apple.authorAuth,
        f.kit.template.id,
        {
          orgId: f.pass.orgId,
          mode: f.pass.mode,
          provider,
          version: f.kit.template.version,
          sourceReleaseId: f.apple.id,
          projection,
        },
      );
      expect(candidate).toMatchObject({ provider, sourceReleaseId: f.apple.id });
    }

    const unsupported = f.kit.registry.add({
      id: `tpl-unsupported-${f.kit.fx.ids.token(4)}`,
      orgId: f.kit.org.id,
      manifest: f.kit.template.manifest,
      passJson: { ...f.kit.template.passJson, backgroundColor: 'rgb(10, 20, 30)' },
      assets: { 'icon.png': ICON_PNG },
    });
    const icon = unsupported.assets.find((asset) => asset.name === 'icon.png');
    if (!icon) throw new Error('Missing unsupported-source fixture icon.');
    icon.slot = 'icon';
    await persistTemplate(f.kit.fx, unsupported, { registry: f.kit.registry });
    const apple = await approveAppleRelease(f.kit, {
      templateId: unsupported.id,
      version: unsupported.version,
    });
    for (const provider of ['google', 'samsung'] as const) {
      await expect(
        createProjectionCandidate(f.kit.ctx, apple.authorAuth, unsupported.id, {
          orgId: f.pass.orgId,
          mode: f.pass.mode,
          provider,
          version: unsupported.version,
          sourceReleaseId: apple.id,
          projection: f.projection(provider),
        }),
      ).rejects.toMatchObject({ code: 'WALLET_PROJECTION_UNSUPPORTED' });
    }
  }, 120_000);

  it.each(['absent', 'configured', 'published'] as OfferFixtureState[])(
    'never exposes Samsung with %s card setup but no verified recipient-market capability',
    async (state) => {
      const f = await setupWalletOfferKit({ google: 'absent', samsung: state });
      expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
      await unavailable(issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'samsung'));
      await expectNoCapabilities(f.kit.env.DB);
    },
  );

  it('does not mistake a reviewed, ACTIVE production card for recipient-market eligibility', async () => {
    const f = await setupWalletOfferKit();
    const approved = await approvedSamsung(f.kit.ctx, f.pass, f.credentialKeysetCommitment);
    expect(approved?.release.id).toBe(f.samsungRelease?.id);
    expect(approved?.projection.provider).toBe('samsung');
    const snapshot = await offerPassSnapshot(f.kit.ctx, f.pass.id, f.credentialKeysetCommitment);
    expect(snapshot).not.toBeNull();
    if (!snapshot) throw new Error('Missing active pass fixture.');
    expect(await eligibleWalletProvider(f.kit.ctx, snapshot, 'samsung')).toBeNull();
    expect(await eligibleWalletProvider(f.kit.ctx, snapshot, 'google')).toBeNull();
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    for (const provider of ['google', 'samsung'] as const)
      await unavailable(issueWalletOffer(f.kit.ctx, f.pass.downloadToken, provider));
    await expectNoCapabilities(f.kit.env.DB);
  });

  it('does not expose Google from configured credentials without publication and replay proof', async () => {
    const f = await setupWalletOfferKit({ google: 'configured', samsung: 'absent' });
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await unavailable(issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'google'));
    await expectNoCapabilities(f.kit.env.DB);
  });

  it('isolates tenant and mode and rejects inactive materializations', async () => {
    const f = await setupWalletOfferKit({ samsung: 'configured' });
    const testPass = await f.kit.pass({ mode: 'test' });
    const foreign = await makeOrg(f.kit.fx);
    const foreignPass = await f.kit.pass({ orgId: foreign.id });
    expect(await listWalletOffers(f.kit.ctx, testPass.id)).toEqual([]);
    expect(await listWalletOffers(f.kit.ctx, foreignPass.id)).toEqual([]);
    for (const statement of [
      "UPDATE passes SET status = 'voided' WHERE id = ?",
      "UPDATE passes SET status = 'active', removed_at = 1 WHERE id = ?",
      'UPDATE passes SET removed_at = NULL, test_data_quarantined = 1 WHERE id = ?',
    ]) {
      await run(f.kit.env.DB, statement, [f.pass.id]);
      expect(
        await offerPassSnapshot(f.kit.ctx, f.pass.id, f.credentialKeysetCommitment),
      ).toBeNull();
      expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
      await unavailable(issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'samsung'));
    }
    await expectNoCapabilities(f.kit.env.DB);
  });

  it('rejects expired pass data and keeps unreviewed semantics out of native projections', async () => {
    const f = await setupWalletOfferKit({ samsung: 'configured' });
    await run(
      f.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(pass_json,
      '$.expirationDate', '2020-01-01T00:00:00Z') WHERE pass_id = ?`,
      [f.pass.id],
    );
    expect(await offerPassSnapshot(f.kit.ctx, f.pass.id, f.credentialKeysetCommitment)).toBeNull();
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await unavailable(issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'samsung'));
    await run(
      f.kit.env.DB,
      `UPDATE pass_versions SET pass_json = json_set(json_remove(pass_json,
      '$.expirationDate'), '$.nfc', json('{"message":"not-approved"}')) WHERE pass_id = ?`,
      [f.pass.id],
    );
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expectNoCapabilities(f.kit.env.DB);
  });

  it('does not fall back to an earlier Apple source or a rotated pass capability', async () => {
    const f = await setupWalletOfferKit();
    expect(await approvedSamsung(f.kit.ctx, f.pass, f.credentialKeysetCommitment)).not.toBeNull();
    await approveAppleRelease(f.kit);
    expect(await approvedSamsung(f.kit.ctx, f.pass, f.credentialKeysetCommitment)).toBeNull();
    await rotateLink(f.kit.ctx, { type: 'system', id: null }, f.pass.id, null);
    await unavailable(issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'samsung'));
    const current = await getPass(f.kit.env.DB, f.pass.id);
    expect(current?.downloadToken).not.toBe(f.pass.downloadToken);
    await unavailable(issueWalletOffer(f.kit.ctx, current!.downloadToken, 'samsung'));
    await expectNoCapabilities(f.kit.env.DB);
  });

  it('pins offer snapshots to credential generations, not link rotations', async () => {
    const f = await setupWalletOfferKit({
      samsung: 'configured',
      holderEmail: 'first-holder@example.test',
    });
    const before = await offerPassSnapshot(f.kit.ctx, f.pass.id, f.credentialKeysetCommitment);
    if (!before) throw new Error('Missing first holder snapshot');
    await rotateLink(f.kit.ctx, { type: 'system', id: null }, f.pass.id, null);
    expect(
      (await offerPassSnapshot(f.kit.ctx, f.pass.id, f.credentialKeysetCommitment))
        ?.credentialGeneration,
    ).toBe(before.credentialGeneration);
    await reassignHolder(
      jobCtxOf(f.kit),
      { type: 'system', id: null },
      { passId: f.pass.id, email: 'second-holder@example.test' },
      null,
    );
    const current = await getPass(f.kit.env.DB, f.pass.id);
    expect(current?.credentialGeneration).toBe(before.credentialGeneration + 1);
    const transfer = await first<{ state: string }>(
      f.kit.env.DB,
      'SELECT state FROM pass_credential_transfers WHERE pass_id = ? ORDER BY target_generation DESC LIMIT 1',
      [f.pass.id],
    );
    const snapshot = await offerPassSnapshot(f.kit.ctx, f.pass.id, f.credentialKeysetCommitment);
    if (transfer?.state === 'pending') expect(snapshot).toBeNull();
    else {
      expect(transfer?.state).toBe('completed');
      expect(snapshot?.credentialGeneration).toBe(current?.credentialGeneration);
    }
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    for (const table of [
      'wallet_provider_offer_refs',
      'wallet_samsung_fetch_refs',
      'wallet_google_callback_bindings',
    ])
      expect(await all(f.kit.env.DB, `SELECT 1 FROM ${table}`)).toEqual([]);
  });

  it('denies unverified provider operations before reading the database', async () => {
    const f = await setupWalletOfferKit({ samsung: 'configured' });
    const db = new Proxy(f.kit.env.DB, {
      get(target, property) {
        if (property === 'prepare') throw new Error('Unexpected provider database access.');
        return Reflect.get(target, property, target);
      },
    });
    const ctx = { ...f.kit.ctx, env: { ...f.kit.env, DB: db } };
    await unavailable(issueWalletOffer(ctx, f.pass.downloadToken, 'google'));
    await unavailable(issueWalletOffer(ctx, f.pass.downloadToken, 'samsung'));
    await unavailable(redeemSamsungOffer(ctx, f.kit.ctx.ids.token(32)));
    await expectNoCapabilities(f.kit.env.DB);
  });

  it('does not disclose a Samsung link for an unknown or malformed wrapper', async () => {
    const f = await setupWalletOfferKit({ google: 'absent', samsung: 'configured' });
    await unavailable(redeemSamsungOffer(f.kit.ctx, 'invalid'));
    await unavailable(redeemSamsungOffer(f.kit.ctx, f.kit.ctx.ids.token(32)));
    await expectNoCapabilities(f.kit.env.DB);
  });

  it('keeps revoked account credentials unavailable', async () => {
    const f = await setupWalletOfferKit({ google: 'absent', samsung: 'configured' });
    const account = await first<{ revision: number }>(
      f.kit.env.DB,
      "SELECT revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'live' AND provider = 'samsung'",
      [f.pass.orgId],
    );
    if (!account) throw new Error('Missing Samsung account fixture.');
    await revokeWalletProviderAccount(f.kit.ctx, f.auth, {
      orgId: f.pass.orgId,
      mode: 'live',
      provider: 'samsung',
      expectedRevision: account.revision,
    });
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await unavailable(issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'samsung'));
    await expectNoCapabilities(f.kit.env.DB);
  });

  it('rate-limits capability routes without returning a provider redirect', async () => {
    const f = await setupWalletOfferKit({ samsung: 'configured' });
    f.kit.env.RL_PUBLIC = fakeLimiter(1) as unknown as RateLimit;
    const app = createApp({ clock: f.kit.clock });
    const path = `/p/${f.pass.downloadToken}/wallet/samsung`;
    const response = await app.request(`https://passbook.mobile${path}`, {}, f.kit.env);
    expect(response.status).toBe(403);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await app.request(`https://passbook.mobile${path}`, {}, f.kit.env)).status).toBe(429);
    await expectNoCapabilities(f.kit.env.DB);
  });
});
