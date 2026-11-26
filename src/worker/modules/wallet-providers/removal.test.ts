import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../platform/service-context.ts';
import { channelOn } from '../channels/gate.ts';
import type { Pass } from '../passes/repo.ts';
import { getWalletInstance } from './instance.ts';
import { walletProviderRevokes } from './provider-policy.ts';
import { removalWallets } from './removal.ts';

vi.mock('./provider-policy.ts', () => ({ walletProviderRevokes: vi.fn(() => true) }));
vi.mock('./instance.ts', () => ({ getWalletInstance: vi.fn() }));
vi.mock('../channels/gate.ts', () => ({ channelOn: vi.fn(async () => true) }));

const pass = { id: 'p1', orgId: 'o1', mode: 'live' } as Pass;
const ctx = { env: { DB: {} } } as unknown as ServiceContext;
const instance = vi.mocked(getWalletInstance);
const channel = vi.mocked(channelOn);
const revokes = vi.mocked(walletProviderRevokes);
const lifecycles = (map: Record<string, string>) =>
  instance.mockImplementation((async (_db: unknown, scope: { provider: string }) =>
    map[scope.provider] ? { lifecycle: map[scope.provider] } : null) as never);

afterEach(() => {
  instance.mockReset();
  revokes.mockImplementation(() => true);
  channel.mockImplementation(async () => true);
});

describe('removalWallets', () => {
  it('is Apple alone while Google and Samsung are dark, whatever copies exist', async () => {
    revokes.mockImplementation(() => false);
    lifecycles({ google: 'active', samsung: 'active' });
    expect(await removalWallets(ctx, pass)).toEqual(['apple']);
    expect(instance).not.toHaveBeenCalled();
  });

  it('adds each released wallet with a live copy and skips the rest', async () => {
    lifecycles({ google: 'active', samsung: 'revoked' });
    expect(await removalWallets(ctx, pass)).toEqual(['apple', 'google']);
    lifecycles({});
    expect(await removalWallets(ctx, pass)).toEqual(['apple']);
    lifecycles({ google: 'active', samsung: 'active' });
    expect(await removalWallets(ctx, pass)).toEqual(['apple', 'google', 'samsung']);
  });

  // Revokes run while draining and for an org that is held or Off, so the removal reaches those copies too.
  it('leaves out only a wallet whose revokes do not run (dark)', async () => {
    lifecycles({ google: 'active', samsung: 'active' });
    revokes.mockImplementation((provider) => provider !== 'samsung');
    expect(await removalWallets(ctx, pass)).toEqual(['apple', 'google']);
  });

  it('leaves out a wallet that is off for the pass org, however live its copy', async () => {
    lifecycles({ google: 'active', samsung: 'active' });
    channel.mockImplementation(async (_ctx, _pass, c) => c !== 'google');
    expect(await removalWallets(ctx, pass)).toEqual(['apple', 'samsung']);
  });
});
