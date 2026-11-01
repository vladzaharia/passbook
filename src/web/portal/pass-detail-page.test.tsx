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
  it('shows fields, links and flips the card', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture()) },
    });
    expect(
      await screen.findByRole('heading', { name: 'Gym membership', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Sam Smith').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download .pkpass' })).toHaveAttribute(
      'href',
      '/p/abcdefghijklmnopqrst/pass.pkpass',
    );
    expect(screen.getByRole('link', { name: 'Public page' })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/p\/abcdefghijklmnopqrst$/),
    );
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('button', { name: 'Front' })).toBeInTheDocument();
    // The far face leaves the tab order and accessibility tree.
    expect(container.querySelector('.pc-face[data-side="front"]')).toHaveAttribute('inert');
    expect(container.querySelector('.pc-face[data-side="back"]')).not.toHaveAttribute('inert');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows a voided banner and no download', async () => {
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture({ status: 'voided' })) },
    });
    expect(await screen.findByText('This pass was voided.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download .pkpass' })).toBeNull();
  });

  it('shows not found', async () => {
    await renderApp('/passes/nope', {});
    expect(await screen.findByText('Pass not found')).toBeInTheDocument();
  });

  it('shows a retry on server errors', async () => {
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => problem(500, 'server_error', 'x') },
    });
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('removes and returns to the list', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/passes/p1', {
      handlers: {
        '/api/v1/me/passes': () => json({ items: [], nextCursor: null }),
        '/api/v1/me/passes/p1': (_u, init) =>
          init?.method === 'DELETE' ? json({ ok: true }) : json(passFixture()),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await screen.findByRole('heading', { name: 'My passes' });
    expect(router.state.location.pathname).toBe('/');
  });
});
