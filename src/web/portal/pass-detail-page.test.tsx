import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { WalletOffer } from '@/shared/contracts/me.ts';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';
import { publicUrlOf } from './wallet-actions.tsx';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A Mac: the badge sits beside the QR. */
const onMac = () => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC);

describe('publicUrlOf', () => {
  it('strips the pkpass suffix', () => {
    expect(publicUrlOf('/p/abcdefghijklmnopqrst/pass.pkpass', 'https://w.test')).toBe(
      'https://w.test/p/abcdefghijklmnopqrst',
    );
  });
  it('returns null for other shapes', () => {
    expect(publicUrlOf('/somewhere/else.pkpass', 'https://w.test')).toBeNull();
  });
});

const nativeOffers: WalletOffer[] = [
  {
    provider: 'google',
    href: '/p/abcdefghijklmnopqrst/wallet/google',
    installation: 'unknown',
  },
  {
    provider: 'samsung',
    href: '/p/abcdefghijklmnopqrst/wallet/samsung',
    installation: 'unknown',
  },
];

describe('pass detail', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1'],
    [
      'iPhone in-app browser',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) GSA/330.0 Mobile/15E148',
    ],
    ['Mac', MAC],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1'],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile'],
    ['Samsung', 'Mozilla/5.0 (Linux; Android 14; SM-S928B) SamsungBrowser/25.0 Mobile'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36'],
  ])('shows every available wallet on %s', async (_name, ua) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture({ walletOffers: nativeOffers })),
      },
    });
    await screen.findByRole('heading', { name: 'Membership', level: 1 });
    expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toHaveAttribute(
      'href',
      '/p/abcdefghijklmnopqrst/pass.pkpass',
    );
    for (const [name, provider, asset] of [
      ['Google', 'google', 'svg'],
      ['Samsung', 'samsung', 'png'],
    ]) {
      const link = screen.getByRole('link', { name: `Add to ${name} Wallet` });
      expect(link).toBeVisible();
      expect(link).toHaveAttribute('href', `/p/abcdefghijklmnopqrst/wallet/${provider}`);
      expect(within(link).getByRole('img')).toHaveAttribute(
        'src',
        `/icons/wallet-providers/${provider}/add-to-${provider}-wallet.${asset}`,
      );
    }
    expect(screen.queryByText(/(?:Google|Samsung) Wallet (?:installed|removed)/i)).toBeNull();
  });

  it('does not mistake an Apple registration for a native-wallet installation', async () => {
    onMac();
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () =>
          json(passFixture({ inWallet: true, walletOffers: nativeOffers })),
      },
    });
    await screen.findByRole('region', { name: 'In Apple Wallet' });
    expect(screen.getByText('If it is missing, add it again.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add to Google Wallet' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Add to Samsung Wallet' })).toBeVisible();
    expect(screen.queryByText(/(?:Google|Samsung) Wallet (?:installed|removed)/i)).toBeNull();
  });

  it('shows no unavailable or stale native choices', async () => {
    const { unmount } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Membership', level: 1 });
    expect(screen.queryByRole('link', { name: 'Add to Google Wallet' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add to Samsung Wallet' })).toBeNull();
    unmount();
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () =>
          json(passFixture({ status: 'voided', walletOffers: nativeOffers })),
      },
    });
    await screen.findByText(/^This pass was voided\./);
    expect(screen.queryByRole('link', { name: 'Add to Google Wallet' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add to Samsung Wallet' })).toBeNull();
  });

  it('does not show stale offers when the server denies presentation eligibility', async () => {
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () =>
          json(passFixture({ presentationEligible: false, walletOffers: nativeOffers })),
      },
    });
    await screen.findByRole('heading', { name: 'Membership', level: 1 });
    expect(screen.queryByRole('link', { name: 'Add to Google Wallet' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Add to Samsung Wallet' })).toBeNull();
  });

  it('shows the card, the badge, a details card without buttons, and flips', async () => {
    onMac();
    const user = userEvent.setup();
    const { container } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    // What the pass is, under its org; the holder's name stays a field.
    expect(
      await screen.findByRole('heading', { name: 'Membership', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Henrys', { selector: 'header p' })).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show barcode' })).toHaveAttribute(
      'href',
      '/api/v1/me/passes/p1/barcode',
    );
    expect(screen.getByText('Best for this device')).toBeInTheDocument();
    expect(screen.queryByText(/NFC/)).toBeNull();
    expect(screen.queryByText(/\.pkpass/)).toBeNull();
    expect(container.querySelector('a[download]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

    const details = screen.getByRole('heading', { name: 'Details' }).parentElement
      ?.parentElement as HTMLElement;
    expect(within(details).queryAllByRole('button')).toHaveLength(0);
    expect(within(details).getByText('Active')).toBeInTheDocument();
    expect(within(details).getAllByText('Sam Smith').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('radio', { name: 'Details' }));
    expect(screen.getByRole('radio', { name: 'Details' })).toBeChecked();
    // The far face leaves the tab order and accessibility tree.
    expect(container.querySelector('.pc-face[data-side="front"]')).toHaveAttribute('inert');
    expect(container.querySelector('.pc-face[data-side="back"]')).not.toHaveAttribute('inert');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps links and Remove in More; the public page opens in a new tab', async () => {
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent?.trim());
    // The page shows its QR itself; Show QR is the tiles' item.
    expect(items).toEqual(['Copy link', 'Open public page', 'Remove from My passes']);
    const open = within(menu).getByRole('menuitem', { name: 'Open public page' });
    expect(open).toHaveAttribute('href', expect.stringMatching(/\/p\/abcdefghijklmnopqrst$/));
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('hides presentation when the server says the pass is not eligible', async () => {
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture({ presentationEligible: false })),
      },
    });
    await screen.findByRole('heading', { name: 'Membership', level: 1 });
    expect(screen.queryByRole('link', { name: 'Show barcode' })).toBeNull();
  });

  it('reports Apple registration without claiming installation, with the badge behind Show QR', async () => {
    onMac();
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture({ inWallet: true })) },
    });
    const add = await screen.findByRole('region', { name: 'In Apple Wallet' });
    expect(screen.getAllByText('In Apple Wallet')).toHaveLength(1);
    expect(within(add).getByText('If it is missing, add it again.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    // Happy, not nudging.
    expect(add.querySelector('[data-buddy]')?.getAttribute('data-scene')).toBe('count');
    await user.click(within(add).getByRole('button', { name: 'Show QR' }));
    expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(within(await screen.findByRole('menu')).queryByText(/Add again/)).toBeNull();
  });

  it('deals the card on a deep link', async () => {
    const { container } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Membership', level: 1 });
    expect(container.querySelector('.pc-stage[data-enter]')).not.toBeNull();
  });

  it('runs the sync rail while a refresh is pending', async () => {
    const { container } = await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture({ refreshRequestedAt: Date.now() - 1000 })),
      },
    });
    await screen.findByRole('heading', { name: 'Membership', level: 1 });
    expect(container.querySelector('.pc-sync-rail')).not.toBeNull();
  });

  it('shows a voided note with the org contact and no wallet actions', async () => {
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () =>
          json(passFixture({ status: 'voided', support: { email: 'help@gym.test', url: null } })),
      },
    });
    expect(await screen.findByText('This pass was voided.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Contact Henrys' })).toHaveAttribute(
      'href',
      'mailto:help@gym.test',
    );
    // The help line gives way to the note: the address is linked once.
    expect(document.querySelectorAll('a[href="mailto:help@gym.test"]')).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Show barcode' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
    expect(screen.getAllByText('Voided').length).toBeGreaterThan(0);
    // The buddy sits on the note, sad.
    expect(document.querySelector('[data-scene="nudge"]')).toBeNull();
    expect(document.querySelector('[data-buddy]')?.getAttribute('data-scene')).toBe('tear');
  });

  it('names the org, not the platform, when a voided pass has no contact of its own', async () => {
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () =>
          json(
            passFixture({
              status: 'voided',
              support: { email: 'support@passbook.test', url: null, platform: true },
            }),
          ),
      },
    });
    expect(await screen.findByText(/Ask Henrys for a new pass\./)).toBeInTheDocument();
    expect(screen.queryByText(/Contact PassBook/)).toBeNull();
    expect(screen.queryByText(/support@passbook\.test/)).toBeNull();
    expect(document.querySelector('a[href="mailto:support@passbook.test"]')).toBeNull();
  });

  it('says a removed pass is removed from Wallet, with the org note and a Removed pill', async () => {
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () =>
          json(
            passFixture({
              status: 'voided',
              removedAt: 1_700_000_100_000,
              removalMessage: 'The season ended.',
            }),
          ),
      },
    });
    expect(
      await screen.findByText(/Removed from Wallet\. It stays in Expired passes/),
    ).toBeInTheDocument();
    expect(screen.getByText('The season ended.')).toBeInTheDocument();
    expect(screen.queryByText('This pass was voided.')).toBeNull();
    expect(screen.getAllByText('Removed').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Show barcode' })).toBeNull();
    expect(document.querySelector('.pc-root[data-removed]')).not.toBeNull();
    expect(document.querySelector('.pc-void')).toBeNull();
  });

  it('lists upcoming events and explains that an Apple Wallet copy may remain', async () => {
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () =>
          json(
            passFixture({
              inWallet: true,
              passJson: {
                organizationName: 'Henrys',
                description: 'Season ticket',
                generic: { primaryFields: [{ key: 'name', label: 'Member', value: 'Sam' }] },
                upcomingPassInformation: [
                  {
                    identifier: 'e1',
                    name: 'Opening night',
                    dateInformation: { date: '2030-05-01T19:00:00Z', timeZone: 'UTC' },
                  },
                ],
              },
            }),
          ),
      },
    });
    const details = (await screen.findByRole('heading', { name: 'Details' })).parentElement
      ?.parentElement as HTMLElement;
    expect(within(details).getByText('Upcoming events')).toBeInTheDocument();
    expect(within(details).getByText('Opening night')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from My passes' }));
    expect(
      within(await screen.findByRole('alertdialog')).getByText(
        /An Apple Wallet copy may remain; delete it there if needed\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows not found under the page header, the buddy mending the torn pass', async () => {
    const { container } = await renderApp('/passes/nope', {});
    expect(await screen.findByText('Pass not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Pass' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to My passes' })).toHaveAttribute('href', '/');
    // An entity not found (buddy spec): torn and mend; lost and peek are for unknown routes.
    expect(container.querySelector('[data-scene="mend"] [data-art="torn"]')).not.toBeNull();
    expect(screen.queryByText(/request/i)).toBeNull();
  });

  it('shows a retry on server errors, under the page header', async () => {
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => problem(500, 'server_error', 'x') },
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Pass' })).toBeInTheDocument();
  });

  it('names the tab and the breadcrumb after what the pass is', async () => {
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Membership', level: 1 });
    await waitFor(() => expect(document.title).toBe('Henrys membership · PassBook'));
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Henrys membership')).toHaveAttribute('aria-current', 'page');
  });

  it('removes from More and returns to the list', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes': () => json({ items: [], nextCursor: null }),
        '/api/v1/me/passes/p1': (_u, init) =>
          init?.method === 'DELETE'
            ? json({ transferId: 'transfer-1', state: 'completed' })
            : json(passFixture()),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove from My passes' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await screen.findByRole('heading', { name: 'My passes' });
    expect(router.state.location.pathname).toBe('/');
  });
});
