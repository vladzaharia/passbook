// TURN-0 rollback: with Google `draining` in Live, an object already saved still goes inactive on a void and on a
// removal (PUT, then a GET to confirm), while an edit, a message and a new save link never reach Google.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { removePass } from '../passes/remove.ts';
import { updatePass, voidPass } from '../passes/service.ts';
import { fixture, mock, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { setWalletReleaseForTest } from './provider-policy.ts';
import { drainWalletProviderSync } from './sync.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const system = { type: 'system', id: null } as const;

/** A saved Google object (released), then Google Live set to draining. */
async function draining() {
  const { f } = await fixture();
  const token = await tokenOf(f);
  await issueWalletOffer(f.kit.ctx, token, 'google');
  restore.push(setWalletReleaseForTest('draining', { provider: 'google', mode: 'live' }));
  const jobCtx = jobCtxOf(f.kit);
  const scope = { orgId: f.kit.org.id, mode: 'live', principal: 'session' } as const;
  const google = () =>
    mock.requests.filter((r) => r.path.includes('walletobjects')).map((r) => r.method);
  return { f, jobCtx, scope, token, google };
}

const object = () => [...mock.google.genericObject.values()][0];

describe('Google draining in Live', () => {
  it('refuses an edit and every new save link, then still sends a void', async () => {
    const { f, jobCtx, scope, token, google } = await draining();
    const before = google().length;
    await updatePass(
      jobCtx,
      system,
      f.pass.id,
      { input: { memberName: 'Edited' } },
      { scope: null },
    );
    await drainWalletProviderSync(jobCtx);
    expect(google()).toHaveLength(before);
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toThrow();
    await voidPass(jobCtx, system, f.pass.id, scope);
    await drainWalletProviderSync(jobCtx);
    expect(google().slice(before)).toContain('PUT');
    expect(google().slice(before)).not.toContain('PATCH');
    expect(object()).toMatchObject({ state: 'INACTIVE' });
  });

  it('sends a removal', async () => {
    const { f, jobCtx, google } = await draining();
    const before = google().length;
    await removePass(jobCtx, system, f.pass.id, {}, null);
    await drainWalletProviderSync(jobCtx);
    expect(google().slice(before)).toContain('PUT');
    expect(object()).toMatchObject({ state: 'INACTIVE' });
  });

  it('calls Google for nothing once dark', async () => {
    const { f, jobCtx, scope, google } = await draining();
    restore.push(setWalletReleaseForTest('dark', { provider: 'google', mode: 'live' }));
    const before = google().length;
    await voidPass(jobCtx, system, f.pass.id, scope);
    await drainWalletProviderSync(jobCtx);
    expect(google()).toHaveLength(before);
  });
});
