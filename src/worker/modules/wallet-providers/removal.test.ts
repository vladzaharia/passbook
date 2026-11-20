import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pass } from '../passes/repo.ts';
import { getWalletInstance } from './instance.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { removalWallets } from './removal.ts';

vi.mock('./instance.ts', () => ({ getWalletInstance: vi.fn() }));

const pass = { id: 'p1', orgId: 'o1', mode: 'live' } as Pass;
const instance = vi.mocked(getWalletInstance);
const lifecycles = (map: Record<string, string>) =>
  instance.mockImplementation((async (_db: unknown, scope: { provider: string }) =>
    map[scope.provider] ? { lifecycle: map[scope.provider] } : null) as never);

afterEach(() => instance.mockReset());

describe('removalWallets', () => {
  it('is Apple alone while Google and Samsung are not released, whatever copies exist', async () => {
    lifecycles({ google: 'active', samsung: 'active' });
    expect(await removalWallets({} as D1Database, pass)).toEqual(['apple']);
    expect(instance).not.toHaveBeenCalled();
  });

  it('adds each released wallet with a live copy and skips the rest', async () => {
    const restore = setWalletProvidersEnabledForTest(true);
    try {
      lifecycles({ google: 'active', samsung: 'revoked' });
      expect(await removalWallets({} as D1Database, pass)).toEqual(['apple', 'google']);
      lifecycles({});
      expect(await removalWallets({} as D1Database, pass)).toEqual(['apple']);
      lifecycles({ google: 'active', samsung: 'active' });
      expect(await removalWallets({} as D1Database, pass)).toEqual(['apple', 'google', 'samsung']);
    } finally {
      restore();
    }
  });
});
