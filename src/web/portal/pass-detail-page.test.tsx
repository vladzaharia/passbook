import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';
import { publicUrlOf } from './wallet-actions.tsx';

afterEach(() => vi.unstubAllGlobals());

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
    const user = userEvent.setup();
    const { container } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    expect(
      await screen.findByRole('heading', { name: 'Gym membership', level: 1 }),
    ).toBeInTheDocument();
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

  it('keeps the badge on a pass already in Wallet, with no custom add item', async () => {
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture({ inWallet: true })) },
    });
    expect(await screen.findByText('In Wallet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toBeInTheDocument();
    // On a device already: no buddy nudging, no slot kept for it.
    expect(document.querySelector('[data-scene="nudge"], .wl-nudge')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(within(await screen.findByRole('menu')).queryByText(/Add again/)).toBeNull();
  });

  it('seats the S buddy on the Details card under the badge, clear of the actions', async () => {
    const { container } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Gym membership', level: 1 });
    const card = screen.getByRole('heading', { name: 'Details' }).parentElement?.parentElement;
    const buddy = container.querySelector('[data-scene="nudge"]');
    // On the card's top edge (the card is its host), at its left end: S, seated, decorative.
    expect(buddy?.parentElement).toBe(card);
    expect(buddy).toHaveClass('wl-buddy', 'wl-nudge');
    expect(buddy).toHaveAttribute('data-at', 'start');
    expect(buddy?.querySelector('svg')).toHaveAttribute('width', '64');
    expect(buddy).toHaveAttribute('aria-hidden', 'true');
    expect(
      buddy?.querySelectorAll('[data-part="l1"], [data-part="l2"], [data-part="sd"]'),
    ).toHaveLength(3);
    // The card follows the badge's block and keeps 56 px clear above it: 44 for the seated
    // buddy, 12 for its fall (18 of the art's 72 units), so it never reaches the actions.
    const badge = screen.getByRole('link', { name: 'Add to Apple Wallet' });
    expect(badge.parentElement?.parentElement?.nextElementSibling).toBe(card);
    expect(card).toHaveClass('mt-8');
    const css = readFileSync(join(process.cwd(), 'src/web/portal/portal.css'), 'utf8');
    expect(css).toMatch(/\.wl-nudge \{\s*--wl-drop: 18px;/);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('deals the card on a deep link', async () => {
    const { container } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Gym membership', level: 1 });
    expect(container.querySelector('.pc-stage[data-enter]')).not.toBeNull();
  });

  it('runs the sync rail while a refresh is pending', async () => {
    const { container } = await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes/p1': () => json(passFixture({ refreshRequestedAt: Date.now() - 1000 })),
      },
    });
    await screen.findByRole('heading', { name: 'Gym membership', level: 1 });
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
    expect(document.querySelector('[data-scene="nudge"]')).toBeNull();
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

  it('names the tab after the pass', async () => {
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Gym membership', level: 1 });
    await waitFor(() => expect(document.title).toBe('Gym membership · PassBook'));
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
