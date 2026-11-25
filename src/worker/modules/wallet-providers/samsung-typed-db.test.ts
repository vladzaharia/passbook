import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { samsungCompiler } from '../../../passkit/wallets/samsung/index.ts';
import { first, run } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { getVersion } from '../templates/repo.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { computeProjectionPins } from './projection-pins.ts';
import { createProjectionCandidate } from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';
import { putSamsungCardState, samsungCardStateFresh } from './repo-samsung-card-state.ts';
import { runtimeGoogleLegacyFixture } from './runtime-integration-fixtures.ts';
import { decryptCard } from './samsung-card-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
const makeEnv = installKeysetTestEnv();

describe('0199 on top of the Google retirement view', () => {
  it('the final retirement view still names the Google union branch and the Samsung base', async () => {
    const { DB } = await makeEnv();
    const view = await first<{ sql: string }>(
      DB,
      "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'wallet_provider_retirement_complete'",
    );
    expect(view?.sql).toContain('wallet_google_retirement_complete');
    expect(view?.sql).toContain('wallet_provider_retirement_complete_base');
    const base = await first<{ sql: string }>(
      DB,
      "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'wallet_provider_retirement_complete_base'",
    );
    expect(base?.sql).toContain("json_extract(candidate.projection_json, '$.schema') = 2");
  });

  it('refuses a card type on a Google instance', async () => {
    const f = await runtimeGoogleLegacyFixture({ db: (await makeEnv()).DB });
    await expect(
      run(f.kit.env.DB, "UPDATE wallet_provider_instances SET card_type = 'loyalty' WHERE id = ?", [
        f.instanceId,
      ]),
    ).rejects.toThrow('a Google instance has no card type');
  });
});

describe('a compiled type with no card of its own', () => {
  let restore: (() => void) | null = null;
  afterEach(() => restore?.());

  it('is Blocked at candidate creation, with the reason', async () => {
    const t = await setupWalletOfferKit({ google: 'absent', samsung: 'configured' });
    const version = await getVersion(t.kit.env.DB, t.kit.template.id, t.kit.template.version);
    if (!version) throw new Error('Missing version');
    const { compile } = samsungCompiler;
    samsungCompiler.compile = (view, options) => ({ ...compile(view, options), type: 'ticket' });
    restore = () => {
      samsungCompiler.compile = compile;
    };
    const { pins } = await computeProjectionPins(t.kit.ctx, 'samsung', version);
    expect(pins.type).toBe('ticket');
    await expect(
      createProjectionCandidate(t.kit.ctx, t.apple.authorAuth, t.kit.template.id, {
        orgId: t.kit.org.id,
        mode: 'live',
        provider: 'samsung',
        version: t.kit.template.version,
        sourceReleaseId: t.apple.id,
        projection: { schema: 2, provider: 'samsung', approvedOmissions: pins.approvedOmissions },
      }),
    ).rejects.toMatchObject({
      code: 'WALLET_PROJECTION_BLOCKED',
      message: 'Blocked: Samsung ticket card not approved.',
    });
  });
});

describe('the card-state row is mode-aware', () => {
  it('a card still in testing mode is fresh in Test and never in Live', async () => {
    const t = await setupWalletOfferKit({ google: 'absent' });
    const candidate = await getProjectionCandidate(
      t.kit.env.DB,
      t.samsungRelease?.candidateId ?? '',
    );
    if (!candidate) throw new Error('Missing candidate');
    const now = t.kit.clock.now();
    expect(
      await putSamsungCardState(t.kit.env.DB, {
        candidateId: candidate.id,
        candidateHash: candidate.candidateHash,
        accountId: candidate.accountId,
        accountEpoch: candidate.accountEpoch,
        cardType: 'loyalty',
        state: 'VERIFYING',
        testingModeOff: 'N',
        verifiedAt: now,
        expiresAt: now + 300_000,
      }),
    ).toBe(true);
    const fresh = (mode: string) =>
      samsungCardStateFresh(t.kit.env.DB, { ...candidate, mode }, 'loyalty', now);
    expect(await fresh('test')).toBe(true);
    expect(await fresh('live')).toBe(false);
  });
});

describe('the Samsung app link (Q22)', () => {
  const appLink = async (t: Awaited<ReturnType<typeof setupSamsungCallbacks>>) => {
    const response = await t.call({ token: await t.token() });
    expect(response.status).toBe(200);
    const { cdata } = (await response.json()) as { cdata: string };
    const card = (await decryptCard(
      cdata,
      t.samsung.partnerCertificatePem,
      t.samsung.partnerPrivateKeyPem,
    )) as { card: { data: { attributes: Record<string, string> }[] } };
    return card.card.data[0]?.attributes.appLinkData;
  };

  it('is the organization website when one is set, else the holder portal', async () => {
    const t = await setupSamsungCallbacks();
    const portal = `${t.kit.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/account`;
    expect(await appLink(t)).toBe(portal);
    await run(
      t.kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'org.website', ?, ?)",
      [`org:${t.kit.org.id}`, JSON.stringify('https://gym.example/'), t.kit.clock.now()],
    );
    clearSettingsCache(t.kit.env.DB);
    expect(await appLink(t)).toBe('https://gym.example/');
  });
});
