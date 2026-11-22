import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { fixture, mock, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { issueWalletOffer } from './offers.ts';
import { countReissueInstances } from './repo-wallet-reissue.ts';
import { drainWalletProviderSync } from './sync.ts';
import { handleWalletReissue } from './wallet-reissue.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const patches = (mark: number) =>
  mock.requests.slice(mark).filter((r) => r.method === 'PATCH' && r.path.includes('Object'));

async function tapped() {
  const { f } = await fixture();
  await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
  const ctx = jobCtxOf(f.kit);
  await drainWalletProviderSync(ctx);
  const scope = { orgId: f.kit.org.id, mode: 'live' as const, provider: 'google' as const };
  const job = (reissueId: string, after?: string) => ({
    kind: 'wallet.reissue' as const,
    reissueId,
    ...scope,
    ...(after ? { after } : {}),
  });
  return { f, ctx, scope, job };
}

describe('wallet reissue', () => {
  it('counts the copies it reaches: the active ones of this wallet and mode, of one template when named', async () => {
    const { f, scope } = await tapped();
    expect(await countReissueInstances(f.kit.env.DB, scope)).toBe(1);
    expect(
      await countReissueInstances(f.kit.env.DB, { ...scope, templateId: f.pass.templateId }),
    ).toBe(1);
    expect(
      await countReissueInstances(f.kit.env.DB, { ...scope, templateId: 'another-template' }),
    ).toBe(0);
    expect(await countReissueInstances(f.kit.env.DB, { ...scope, provider: 'samsung' })).toBe(0);
    expect(await countReissueInstances(f.kit.env.DB, { ...scope, mode: 'test' })).toBe(0);
  });

  it('sends the same pass again under a new operation, once per reissue however often the job runs', async () => {
    const { ctx, job } = await tapped();
    const mark = mock.requests.length;
    await drainWalletProviderSync(ctx);
    expect(patches(mark)).toHaveLength(0);

    await handleWalletReissue(job('reissue-1'), ctx);
    await drainWalletProviderSync(ctx);
    expect(patches(mark)).toHaveLength(1);

    // A redelivered job finds its operation and adds none.
    await handleWalletReissue(job('reissue-1'), ctx);
    await drainWalletProviderSync(ctx);
    expect(patches(mark)).toHaveLength(1);

    await handleWalletReissue(job('reissue-2'), ctx);
    await drainWalletProviderSync(ctx);
    expect(patches(mark)).toHaveLength(2);
  });

  it('leaves a voided pass to its revoke: a reissue never re-opens it', async () => {
    const { f, ctx, job } = await tapped();
    const { voidPass } = await import('../passes/service.ts');
    await voidPass(ctx, { type: 'system', id: null }, f.pass.id, {
      orgId: f.kit.org.id,
      mode: 'live',
      principal: 'session',
    });
    await drainWalletProviderSync(ctx);
    await handleWalletReissue(job('reissue-3'), ctx);
    await drainWalletProviderSync(ctx);
    const [object] = [...mock.google.genericObject.values()];
    expect(object).toMatchObject({ state: 'INACTIVE' });
  });
});
