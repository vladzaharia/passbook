import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { credential, platformEnrolment, walletRelease } from './wallet-accounts-test-fixtures.ts';

const open = (release: ReturnType<typeof walletRelease>, provider: 'google' | 'samsung') =>
  renderApp('/admin/platform/wallet-accounts', {
    session: 'admin',
    handlers: {
      '/api/v1/wallet-identities': () => json({ items: [], nextCursor: null }),
      '/api/v1/platform/wallet-credentials': () =>
        json({
          items: [
            credential({ scope: 'platform', orgId: null, mode: 'live', provider, cardTypes: [] }),
          ],
          nextCursor: null,
          release,
        }),
      '/api/v1/platform/wallet-enrolments': () =>
        json({
          items: [
            platformEnrolment({ provider, mode: 'live' }),
            platformEnrolment({ provider, mode: 'test', orgId: 'o2', orgName: 'Acme' }),
          ],
          nextCursor: null,
        }),
    },
  });

describe('release line on the platform wallet tabs', () => {
  it('says Google is not released above the credentials and on each dark enrolment', async () => {
    const user = userEvent.setup();
    const { container } = await open(walletRelease(), 'google');
    await user.click(await screen.findByRole('tab', { name: 'Google' }));
    await screen.findByText('…4321');
    // One in the credentials card, one for each enrolment row.
    expect(screen.getAllByText("Google Wallet isn't released yet.")).toHaveLength(3);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('says Test only when only Test is open, and marks just the Live enrolment', async () => {
    const user = userEvent.setup();
    await open(walletRelease(true), 'google');
    await user.click(await screen.findByRole('tab', { name: 'Google' }));
    expect(await screen.findByText('Google Wallet is released in Test only.')).toBeInTheDocument();
    expect(screen.getAllByText("Google Wallet isn't released yet.")).toHaveLength(1);
  });

  it('says nothing when both modes are released', async () => {
    const user = userEvent.setup();
    await open(walletRelease(true, true), 'google');
    await user.click(await screen.findByRole('tab', { name: 'Google' }));
    await screen.findByText('…4321');
    expect(screen.queryByText(/released/)).toBeNull();
  });

  it('puts the line in the Samsung cards', async () => {
    const user = userEvent.setup();
    await open(walletRelease(), 'samsung');
    await user.click(await screen.findByRole('tab', { name: 'Samsung' }));
    const cards = await screen.findByRole('list', { name: 'Samsung cards' });
    expect(within(cards).getByText("Samsung Wallet isn't released yet.")).toBeInTheDocument();
  });
});
