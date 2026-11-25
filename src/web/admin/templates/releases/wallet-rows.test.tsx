import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { setCsrfProvider } from '../../../lib/api.ts';
import { resetModeForTests } from '../../../lib/mode.ts';
import { json } from '../../../lib/test-utils.tsx';
import { mountPanel, release, releaseServer } from './test-fixtures.tsx';

beforeEach(() => setCsrfProvider(async () => 'csrf-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
  setCsrfProvider(async () => undefined);
});

const enrolment = (
  provider: 'google' | 'samsung',
  state: string,
  issuance: { state: 'enabled' } | { state: 'disabled'; reason: 'not_released' },
) => ({
  mode: 'live',
  provider,
  accountId: null,
  source: null,
  platformAvailable: true,
  state,
  enrolmentRevision: 0,
  prerequisites: { check: false, roundTrip: null },
  hold: null,
  issuance,
});

/** The release server plus the enrolment list the rows read. */
function serve(items: unknown[]) {
  const server = releaseServer({ active: release() });
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input), 'http://localhost').pathname === '/api/v1/orgs/org-1/wallet-enrolments'
      ? Promise.resolve(json({ items, nextCursor: null }))
      : inner(input, init),
  );
  return server;
}

describe('wallet rows', () => {
  it('hides the wallets card while Google and Samsung are off', async () => {
    serve([
      enrolment('google', 'off', { state: 'disabled', reason: 'not_released' }),
      enrolment('samsung', 'absent', { state: 'enabled' }),
    ]);
    const { container } = mountPanel();
    await screen.findByRole('heading', { name: 'Versions' });
    await waitFor(() => expect(screen.queryByText('Checking.')).toBeNull());
    expect(screen.queryByRole('list', { name: 'Wallets' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Review (Google|Samsung)/ })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('reads an enabled wallet release and opens its review', async () => {
    serve([enrolment('google', 'on', { state: 'enabled' })]);
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
});
