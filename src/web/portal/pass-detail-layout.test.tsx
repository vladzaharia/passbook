import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { json, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36';

function as(userAgent: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

afterEach(() => vi.restoreAllMocks());

async function open(ua: string, over: Parameters<typeof passFixture>[0] = {}) {
  as(ua);
  const view = await renderApp('/passes/p1', {
    handlers: { '/api/v1/me/passes/p1': () => json(passFixture(over)) },
  });
  await screen.findByRole('heading', { name: 'Gym membership', level: 1 });
  const badge = screen.getByRole('link', { name: 'Add to Apple Wallet' });
  const card = screen.getByRole('heading', { name: 'Details' }).parentElement?.parentElement;
  const buddy = view.container.querySelector('[data-scene="nudge"]');
  return { ...view, badge, card, buddy };
}

const portalCss = () => readFileSync(join(process.cwd(), 'src/web/portal/portal.css'), 'utf8');

describe('pass page add block', () => {
  it('stacks the badge, Refresh and More beside the QR, the phone captioned under it', async () => {
    const { badge, container } = await open(MAC);
    const stack = badge.parentElement as HTMLElement;
    // One column, in this order, each as wide as the column (the badge's width) and badge-high.
    expect([...stack.children]).toEqual([
      badge,
      screen.getByRole('button', { name: 'Refresh' }),
      screen.getByRole('button', { name: 'More' }),
    ]);
    expect(stack).toHaveClass('flex', 'w-fit', 'flex-col', 'gap-3.5', 'pointer-coarse:gap-2');
    // The gaps around the badge are its clear space; its art lines up with the buttons.
    expect(badge).toHaveClass('p-0');
    // More keeps its word in the column, phones included.
    expect(screen.getByText('More')).not.toHaveClass('max-sm:sr-only');
    const phone = stack.previousElementSibling as HTMLElement;
    const qr = await screen.findByRole('img', { name: HOLDER_COPY.qrAlt('Gym membership') });
    expect(phone.contains(qr)).toBe(true);
    expect(phone.lastElementChild).toHaveTextContent(HOLDER_COPY.scanQr);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps the row on the phone: the badge leads, Refresh and More follow as a pair', async () => {
    const { badge } = await open(IPHONE);
    expect(screen.queryByText(HOLDER_COPY.scanQr)).toBeNull();
    const row = badge.parentElement as HTMLElement;
    expect(row).toHaveClass('flex-wrap', 'items-center');
    const pair = row.lastElementChild as HTMLElement;
    expect([...pair.children]).toEqual([
      screen.getByRole('button', { name: 'Refresh' }),
      screen.getByRole('button', { name: 'More' }),
    ]);
    // In a row More gives up its word on phones.
    expect(screen.getByText('More')).toHaveClass('max-sm:sr-only');
  });
});

describe('the nudge (not on a device yet)', () => {
  it('sits past the stack on the Details card, below it, aiming up-left at the badge', async () => {
    const { buddy, card, container } = await open(MAC);
    // On the card's top edge (the card is its host): S, seated, decorative.
    expect(buddy?.parentElement).toBe(card);
    expect(buddy).toHaveClass('wl-buddy', 'wl-nudge', 'wl-nudge-beside');
    expect(buddy).toHaveAttribute('data-at', 'start');
    expect(buddy).toHaveAttribute('aria-hidden', 'true');
    expect(buddy?.querySelector('svg')).toHaveAttribute('width', '64');
    expect(
      buddy?.querySelectorAll('[data-part="l1"], [data-part="l2"], [data-part="sd"]'),
    ).toHaveLength(3);
    // 32 px over the caption: falling (44 + 12) it stays below the 148 px stack.
    expect(card).toHaveClass('mt-2');
    const css = portalCss();
    expect(css).toMatch(
      /\.wl-nudge-beside \{\s*--wl-buddy-inset: min\(8\.25rem \+ 1rem \+ 2\.5rem \* 110\.095 \/ 34\.016 \+ 1rem, 100% - 4\.75rem\);/,
    );
    expect(css).toMatch(/--wl-aim: 0\.5;\s*--wl-look: -1\.6px -1\.8px;/);
    expect(container.querySelector('.wl-nudge-beside')).toBe(buddy);
  });

  it('sits under the badge on the phone, the card 56 px clear of the row', async () => {
    const { buddy, card, badge } = await open(IPHONE);
    expect(buddy?.parentElement).toBe(card);
    expect(buddy).toHaveClass('wl-nudge');
    expect(buddy).not.toHaveClass('wl-nudge-beside');
    // 44 for the seated buddy, 12 for its fall (18 of the art's 72 units).
    expect(card).toHaveClass('mt-8');
    expect(badge.parentElement?.parentElement?.nextElementSibling).toBe(card);
    expect(portalCss()).toMatch(/\.wl-nudge \{\s*--wl-drop: 18px;/);
  });

  it('stays away where the badge cannot add: the line says where to go', async () => {
    const { buddy, card } = await open(WINDOWS);
    expect(screen.getByText(HOLDER_COPY.scanQr)).toBeInTheDocument();
    expect(screen.getByText(HOLDER_COPY.openOnApple)).toBeInTheDocument();
    expect(buddy).toBeNull();
    expect(card).not.toHaveClass('mt-2');
    expect(card).not.toHaveClass('mt-8');
  });
});
