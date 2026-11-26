// The move asks Google whether a pass's live object has users: the real runtime, on the mock wallet server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleCopyHasUsers } from './google-copy-users.ts';
import { fixture, mock, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { issueWalletOffer } from './offers.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const ofPass = (f: Awaited<ReturnType<typeof fixture>>['f']) => ({
  id: f.pass.id,
  orgId: f.pass.orgId,
  mode: f.pass.mode,
});
const objects = () => [...mock.google.genericObject.values()];

describe('googleCopyHasUsers', () => {
  it('reads hasUsers off the live object, and sends nothing but GETs', async () => {
    const { f } = await fixture();
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    expect(objects()).toHaveLength(1);
    const mark = mock.requests.length;
    expect(await googleCopyHasUsers(f.kit.ctx, ofPass(f))).toBe(false);
    Object.assign(objects()[0] ?? {}, { hasUsers: true });
    expect(await googleCopyHasUsers(f.kit.ctx, ofPass(f))).toBe(true);
    const sent = mock.requests.slice(mark).filter((r) => !/oauth|token/.test(r.path));
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((r) => r.method))).toEqual(new Set(['GET']));
  });

  it('answers false for an object Google no longer has', async () => {
    const { f } = await fixture();
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    mock.google.genericObject.clear();
    expect(await googleCopyHasUsers(f.kit.ctx, ofPass(f))).toBe(false);
  });

  it('cannot answer for a pass with no live Google copy', async () => {
    const { f } = await fixture();
    expect(await googleCopyHasUsers(f.kit.ctx, ofPass(f))).toBeNull();
  });

  it('cannot answer when Google fails', async () => {
    const { f } = await fixture();
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('walletobjects.googleapis.com')) return new Response('no', { status: 500 });
      return real(input, init);
    });
    expect(await googleCopyHasUsers(f.kit.ctx, ofPass(f))).toBeNull();
  });
});
