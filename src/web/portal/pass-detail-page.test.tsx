import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';
import { publicUrlOf } from './wallet-actions.tsx';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A Mac: the badge sits beside the QR (elsewhere off Apple's devices the scan is the way). */
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

describe('pass detail', () => {
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
    expect(items).toEqual(['Copy link', 'Open public page', 'Remove']);
    const open = within(menu).getByRole('menuitem', { name: 'Open public page' });
    expect(open).toHaveAttribute('href', expect.stringMatching(/\/p\/abcdefghijklmnopqrst$/));
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('says In Apple Wallet once on a device, the badge behind Show QR', async () => {
    onMac();
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture({ inWallet: true })) },
    });
    const add = await screen.findByRole('region', { name: 'In Apple Wallet' });
    expect(screen.getAllByText('In Apple Wallet')).toHaveLength(1);
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
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
    expect(screen.getAllByText('Voided').length).toBeGreaterThan(0);
    // The buddy sits on the note, sad.
    expect(document.querySelector('[data-scene="nudge"]')).toBeNull();
    expect(document.querySelector('[data-buddy]')?.getAttribute('data-scene')).toBe('tear');
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
          init?.method === 'DELETE' ? json({ ok: true }) : json(passFixture()),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await screen.findByRole('heading', { name: 'My passes' });
    expect(router.state.location.pathname).toBe('/');
  });
});
