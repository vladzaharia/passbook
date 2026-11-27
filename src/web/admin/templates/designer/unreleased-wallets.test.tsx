import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { RELEASE } from '../../../../worker/modules/wallet-providers/release.ts';
import { createQueryClient } from '../../../lib/query-client.ts';
import { anonymousDesignerHost, unreleasedWallets } from './hosts.tsx';
import { useWalletChannels } from './wallets/use-wallet-channels.ts';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>
);

describe('wallets the platform has not released', () => {
  it('follows the one release table', () => {
    expect([...unreleasedWallets('test')].sort()).toEqual(
      (['google', 'samsung'] as const).filter((w) => RELEASE[w].test !== 'released'),
    );
  });

  it('the signed-out host withholds them', () => {
    expect(anonymousDesignerHost({}).unreleased).toEqual(unreleasedWallets('test'));
  });

  it('lists no tile for a withheld wallet', () => {
    const none = renderHook(
      () => useWalletChannels(undefined, undefined, new Set(['google', 'samsung'])),
      { wrapper },
    );
    expect(none.result.current.listed).toEqual([]);
    const one = renderHook(() => useWalletChannels(undefined, undefined, new Set(['google'])), {
      wrapper,
    });
    expect(one.result.current.listed).toEqual(['samsung']);
  });
});
