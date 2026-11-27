import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { json } from '../../../lib/test-utils.tsx';
import { mountPanel, release, releaseServer, TEMPLATE } from './test-fixtures.tsx';

beforeEach(() => setCsrfProvider(async () => 'csrf-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

type Wallet = 'on' | 'off' | 'not_released';

/** The release server plus the wallet state the candidate lists carry for a caller who can review. */
function serve(wallets: Partial<Record<'google' | 'samsung', Wallet>>) {
  const server = releaseServer({ active: release() });
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const provider = url.searchParams.get('provider');
    if (
      url.pathname === `/api/v1/templates/${TEMPLATE}/candidates` &&
      (provider === 'google' || provider === 'samsung')
    )
      return Promise.resolve(
        json({
          items: [],
          nextCursor: null,
          ...(wallets[provider] ? { wallet: wallets[provider] } : {}),
        }),
      );
    return inner(input, init);
  });
  return server;
}

describe('wallet rows', () => {
  it('hides the wallets card while Google and Samsung are off', async () => {
    serve({ google: 'not_released', samsung: 'off' });
    const { container } = mountPanel();
    await screen.findByRole('heading', { name: 'Versions' });
    await waitFor(() => expect(screen.queryByText('Checking.')).toBeNull());
    expect(screen.queryByRole('list', { name: 'Wallets' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Review (Google|Samsung)/ })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('reads an enabled wallet release and opens its review', async () => {
    serve({ google: 'on', samsung: 'off' });
    mountPanel();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Review Google Wallet' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Review Google Wallet' }));
    expect(screen.getByRole('button', { name: 'Review Google Wallet' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows nothing when the lists carry no wallet state, as for a person who cannot review', async () => {
    serve({});
    mountPanel();
    await screen.findByRole('heading', { name: 'Versions' });
    await waitFor(() => expect(screen.queryByText('Checking.')).toBeNull());
    expect(screen.queryByRole('list', { name: 'Wallets' })).toBeNull();
  });
});
