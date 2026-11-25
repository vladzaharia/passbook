import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, restore } from './google-runtime-test-fixtures.ts';
import { getApprovedProjection } from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { assertWalletRuntimeAccount, createSamsungRuntimeOffer } from './runtime.ts';
import { runtimeGoogleAccount, runtimeSamsungAccount, SAMSUNG_ISSUANCE } from './runtime-core.ts';
import { runtimeSamsungLegacyFixture } from './runtime-samsung-integration-fixtures.ts';
import { createSamsungRefId } from './samsung.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

describe('Samsung issuance credential path', () => {
  it('reads under the issuance purpose, builds the offer link and keeps unpurposed reads refused', async () => {
    const f = await runtimeSamsungLegacyFixture('refresh');
    const { ctx } = f.kit;
    await expect(runtimeSamsungAccount(ctx, f.scope)).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    await expect(runtimeSamsungAccount(ctx, f.scope, SAMSUNG_ISSUANCE)).resolves.toMatchObject({
      cardId: 'membership',
    });
    await expect(assertWalletRuntimeAccount(ctx, f.scope, 'samsung')).resolves.toBeUndefined();
    const link = await createSamsungRuntimeOffer(ctx, f.scope, { refId: createSamsungRefId() });
    expect(link.startsWith('https://a.swallet.link/atw/v3/')).toBe(true);
  });

  it('is scoped to the org and to Samsung', async () => {
    const f = await runtimeSamsungLegacyFixture('refresh');
    const { ctx } = f.kit;
    await expect(
      runtimeSamsungAccount(ctx, { ...f.scope, orgId: ctx.ids.id() }, SAMSUNG_ISSUANCE),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    await expect(runtimeSamsungAccount(ctx, f.scope, { kind: 'issuance' })).rejects.toMatchObject({
      code: 'account_unavailable',
    });
  });

  it('does not open a Google read: a valid Google scope refuses the Samsung purpose only', async () => {
    const { f } = await fixture();
    const { pass, kit } = f;
    if (!pass.releaseId) throw new Error('Missing source release.');
    const approved = await getApprovedProjection(kit.ctx, {
      orgId: pass.orgId,
      mode: pass.mode,
      provider: 'google',
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      appleReleaseId: pass.releaseId,
    });
    if (!approved) throw new Error('Missing approved Google projection.');
    const scope = {
      orgId: pass.orgId,
      mode: pass.mode,
      accountId: approved.release.accountId,
      accountRevision: approved.release.accountRevision,
      providerIdentityHash: approved.release.providerIdentityHash,
      providerReleaseId: approved.release.id,
    };
    // Control: the same scope opens under Google's own purpose, so only the purpose check refuses below.
    await expect(runtimeGoogleAccount(kit.ctx, scope, { kind: 'issuance' })).resolves.toBeDefined();
    await expect(runtimeGoogleAccount(kit.ctx, scope, SAMSUNG_ISSUANCE)).rejects.toMatchObject({
      code: 'account_unavailable',
    });
  });
});
