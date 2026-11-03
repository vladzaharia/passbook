import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, within } from '@testing-library/react';
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

  it('keeps links and Remove in More', async () => {
    const user = userEvent.setup();
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await user.click(await screen.findByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent?.trim());
    expect(items).toEqual(['Show QR', 'Copy link', 'Open public page', 'Remove']);
    expect(within(menu).getByRole('menuitem', { name: 'Open public page' })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/p\/abcdefghijklmnopqrst$/),
    );
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

  it('seats the buddy on the Details card, its head in a slot the actions keep clear', async () => {
    const { container } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    await screen.findByRole('heading', { name: 'Gym membership', level: 1 });
    const card = screen.getByRole('heading', { name: 'Details' }).parentElement?.parentElement;
    const buddy = container.querySelector('[data-scene="nudge"]');
    // On the card's top edge (the card is its host), seated: legs and a shadow; decorative.
    expect(buddy?.parentElement).toBe(card);
    expect(buddy).toHaveClass('wl-buddy', 'wl-nudge');
    expect(buddy).toHaveAttribute('aria-hidden', 'true');
    expect(
      buddy?.querySelectorAll('[data-part="l1"], [data-part="l2"], [data-part="sd"]'),
    ).toHaveLength(3);
    // The actions row ends with the slot, which wraps under the actions when they need the room.
    const row = screen.getByRole('link', { name: 'Add to Apple Wallet' }).parentElement;
    expect(row?.lastElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(row?.lastElementChild).toHaveClass('ml-auto', 'self-end', 'h-5', 'w-18');
    // Right end of the edge, base on it (66 of 72); a phone's falls from under the actions.
    const css = readFileSync(join(process.cwd(), 'src/web/portal/portal.css'), 'utf8');
    expect(css).toMatch(
      /\.wl-buddy\.wl-nudge \{\s*left: auto;\s*right: 8px;\s*translate: 0 -91\.67%;/,
    );
    expect(css).toMatch(/max-width: 39\.99rem\) \{\s*\.wl-nudge \{\s*--wl-drop: 20px;/);
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

  it('shows a voided note and no wallet actions', async () => {
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture({ status: 'voided' })) },
    });
    expect(await screen.findByText('This pass was voided.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Refresh/ })).toBeNull();
    expect(screen.getAllByText('Voided').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-scene="nudge"]')).toBeNull();
  });

  it('shows not found with a way back', async () => {
    const { container } = await renderApp('/passes/nope', {});
    expect(await screen.findByRole('heading', { name: 'Pass not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to My passes' })).toHaveAttribute('href', '/');
    expect(container.querySelector('[data-art="wallet"][data-state="lost"]')).not.toBeNull();
    expect(screen.queryByText(/request/i)).toBeNull();
  });

  it('shows a retry on server errors', async () => {
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => problem(500, 'server_error', 'x') },
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
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
