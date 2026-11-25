import { beforeAll, describe, expect, it } from 'vitest';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { assertWalletRuntimeAccount, createSamsungRuntimeOffer } from './runtime.ts';
import { runtimeGoogleAccount, runtimeSamsungAccount, SAMSUNG_ISSUANCE } from './runtime-core.ts';
import { runtimeSamsungLegacyFixture } from './runtime-samsung-integration-fixtures.ts';
import { createSamsungRefId } from './samsung.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
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
    // The mirror: Samsung's purpose does not open a Google read.
    await expect(runtimeGoogleAccount(ctx, f.scope, SAMSUNG_ISSUANCE)).rejects.toMatchObject({
      code: 'account_unavailable',
    });
  });
});
