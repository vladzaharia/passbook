import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '../lib/test-utils.tsx';
import { useBuddyOnScreen } from '../ui/art/presence.ts';
import { passFixture } from './fixtures.ts';
import { listAct } from './my-passes-page.tsx';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';
const list = (...items: ReturnType<typeof passFixture>[]) => json({ items, nextCursor: null });
const out = (id: string) => passFixture({ id, title: id });
const added = (id: string) => passFixture({ id, title: id, inWallet: true });
const voided = (id: string) => passFixture({ id, title: id, status: 'voided' });

afterEach(() => vi.restoreAllMocks());

describe('my passes buddy', () => {
  it('acts out the list: nudge, tuck, count or a sigh', () => {
    // Two or more to add: the bundle badge is right above it.
    expect(listAct([out('a'), out('b'), added('c')])).toEqual({ scene: 'nudge' });
    // One to add, so no bundle: it drops a pass into its pocket.
    expect(listAct([out('a')])).toEqual({ scene: 'tuck' });
    expect(listAct([added('a'), voided('b'), out('c')])).toEqual({ scene: 'tuck' });
    // Every live pass in a Wallet; voided ones do not count.
    expect(listAct([added('a'), voided('b')])).toEqual({ mood: 'happy', scene: 'count' });
    expect(listAct([voided('a')])).toEqual({ mood: 'sad', scene: 'beat' });
  });

  it('sits on the first tile only, S at its start, hidden from assistive tech', async () => {
    await renderApp('/', {
      handlers: { '/api/v1/me/passes': () => list(added('a'), out('b'), out('c')) },
    });
    await screen.findByRole('heading', { name: 'c', level: 2 });
    const buddies = document.querySelectorAll('[data-buddy]');
    expect(buddies).toHaveLength(1);
    const [first] = screen.getAllByRole('listitem');
    const buddy = first?.querySelector('[data-buddy]');
    expect(buddy).toHaveAttribute('data-scene', 'nudge');
    expect(buddy).toHaveAttribute('data-at', 'start');
    expect(buddy).toHaveAttribute('aria-hidden', 'true');
    expect(buddy?.querySelector('svg')).toHaveAttribute('data-size', 'sm');
    // Seated on the tile's own frame, never over the pass art.
    expect(buddy?.parentElement).toHaveClass('rounded-xl');
  });

  it('is a page buddy: success toasts show a check while it is mounted', async () => {
    let onScreen = false;
    function Probe() {
      onScreen = useBuddyOnScreen();
      return null;
    }
    render(<Probe />);
    await renderApp('/', { handlers: { '/api/v1/me/passes': () => list(added('a')) } });
    await screen.findByRole('heading', { name: 'a', level: 2 });
    expect(document.querySelector('[data-buddy]')).toHaveAttribute('data-scene', 'count');
    expect(onScreen).toBe(true);
  });

  it('keeps its room above the grid from the skeleton on, with no empty row above it', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await renderApp('/', {
      handlers: { '/api/v1/me/passes': () => gate.then(() => list(out('a'))) },
    });
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toHaveClass('mt-8'));
    release();
    await screen.findByRole('heading', { name: 'a', level: 2 });
    expect(screen.getByRole('list')).toHaveClass('mt-8');
    // One pass to add on a Mac: no bundle and no line, so nothing sits between header and grid.
    expect(document.querySelector('.wl-passes')?.firstElementChild).toContainElement(
      screen.getByRole('list'),
    );
  });
});
