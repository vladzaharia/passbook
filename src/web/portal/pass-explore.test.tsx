import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { json, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';
const QR = 'QR code for Gym membership';

/** The encoder's image (it replaces a placeholder with the same name once loaded). */
const qrImage = () =>
  waitFor(() => {
    const img = document.querySelector<HTMLImageElement>(`img[alt="${QR}"]`);
    expect(img).not.toBeNull();
    return img as HTMLImageElement;
  });

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

/** The pass page under `?add=<dir>` (a dev build reads it from the address bar). */
async function open(dir: string, ua: string, over: Parameters<typeof passFixture>[0] = {}) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  window.history.replaceState(null, '', `/passes/p1?add=${dir}`);
  const pass = passFixture({
    passJson: { ...passFixture().passJson, description: 'Henrys membership' },
    ...over,
  });
  const view = await renderApp('/passes/p1', {
    handlers: { '/api/v1/me/passes/p1': () => json(pass) },
  });
  const h1 = await screen.findByRole('heading', { level: 1, name: (n) => n !== 'Pass' });
  const header = h1.closest('header') as HTMLElement;
  return { ...view, h1, header };
}

describe('pass page explorations (?add=)', () => {
  it('a: the title says what the pass is; Refresh and More sit in the header', async () => {
    const { h1, header, container } = await open('a', MAC);
    expect(h1).toHaveTextContent('Henrys membership');
    expect(document.title).toBe('Henrys membership · PassBook');
    expect(within(header).getByRole('button', { name: 'Refresh' })).toBeVisible();
    expect(within(header).getByRole('button', { name: 'More' })).toBeVisible();
    const add = screen.getByRole('region', { name: 'Add to Apple Wallet' });
    expect(add.contains(await qrImage())).toBe(true);
    expect(within(add).getByRole('link', { name: 'Add to Apple Wallet' })).toBeVisible();
    // The add block only adds; the old nudge is gone.
    expect(within(add).queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-scene="nudge"]')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('b: the org over the kind beside the pass, the QR in the drawn iPhone', async () => {
    const { h1, header, container } = await open('b', MAC);
    expect(h1).toHaveTextContent(/^Membership$/);
    expect(within(header).getByText('Henrys')).toBeVisible();
    expect(within(header).getByRole('button', { name: 'More actions' })).toBeVisible();
    expect((await qrImage()).closest('.wl-ph')).not.toBeNull();
    expect(container.querySelector('.wl-b-dock')).toBeNull();
  });

  it('c: the buddy sits on the QR’s sign and points at it', async () => {
    const { container } = await open('c', MAC);
    const sign = (await qrImage()).closest('.wl-c-sign') as HTMLElement;
    expect(sign.querySelector('[data-scene="nudge"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-buddy]')).toHaveLength(1);
  });

  it.each(['a', 'b', 'c'])(
    '%s: in Apple Wallet, a calm line; Show QR opens adding again',
    async (dir) => {
      await open(dir, MAC, { inWallet: true });
      const add = screen.getByRole('region', { name: 'In Apple Wallet' });
      expect(within(add).getByText('Updates arrive on their own.')).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
      expect(screen.queryByRole('img', { name: QR })).toBeNull();
      const show = within(add).getByRole('button', { name: 'Show QR' });
      expect(show).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(show);
      expect(await qrImage()).toBeVisible();
      expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toBeVisible();
      expect(within(add).getByRole('button', { name: 'Hide QR' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    },
  );

  it.each(['a', 'b', 'c'])('%s: the iPhone gets the badge, never the QR', async (dir) => {
    const { container } = await open(dir, IPHONE);
    expect(screen.getByRole('link', { name: 'Add to Apple Wallet' })).toBeVisible();
    expect(screen.queryByRole('img', { name: QR })).toBeNull();
    // b keeps it in reach: a dock at the foot of the screen.
    expect(container.querySelector('.wl-b-dock [data-awb]') !== null).toBe(dir === 'b');
  });

  it.each(['a', 'b', 'c'])('%s: voided says so and offers no add', async (dir) => {
    const { container, header } = await open(dir, MAC, { status: 'voided' });
    expect(screen.getByText(HOLDER_COPY.voided)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    expect(within(header).queryByRole('button', { name: 'Refresh' })).toBeNull();
    // c's buddy is sad on the notice.
    const buddy = container.querySelector('[data-buddy]');
    expect(buddy?.getAttribute('data-scene') ?? null).toBe(dir === 'c' ? 'tear' : null);
  });
});
