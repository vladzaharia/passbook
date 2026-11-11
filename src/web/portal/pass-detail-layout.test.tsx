import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { json, renderApp } from '../lib/test-utils.tsx';
import { passFixture } from './fixtures.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1';
const IN_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) GSA/330.0 Mobile/15E148';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';
const QR = HOLDER_COPY.qrAlt('Gym membership');

afterEach(() => vi.restoreAllMocks());

/** The encoder's image (it replaces a placeholder with the same name once loaded). */
const qrImage = () =>
  waitFor(() => {
    const img = document.querySelector<HTMLImageElement>(`img[alt="${QR}"]`);
    expect(img).not.toBeNull();
    return img as HTMLImageElement;
  });

async function open(ua: string, over: Parameters<typeof passFixture>[0] = {}) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  const view = await renderApp('/passes/p1', {
    handlers: { '/api/v1/me/passes/p1': () => json(passFixture(over)) },
  });
  const h1 = await screen.findByRole('heading', { level: 1, name: 'Membership' });
  return { ...view, header: h1.closest('header') as HTMLElement };
}

const buddies = () => [...document.querySelectorAll<HTMLElement>('[data-buddy]')];

describe('pass page header', () => {
  it('carries Refresh and More, so the add block only adds', async () => {
    const { header, container } = await open(MAC);
    expect(within(header).getByRole('button', { name: 'Refresh' })).toBeVisible();
    expect(within(header).getByRole('button', { name: 'More' })).toBeVisible();
    const add = screen.getByRole('region', { name: HOLDER_COPY.addTitle });
    expect(within(add).queryByRole('button')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('pass page add block', () => {
  it('Mac: the buddy on the QR’s sign points at it; the badge adds beside it', async () => {
    await open(MAC);
    const sign = (await qrImage()).closest('.wl-sign') as HTMLElement;
    const buddy = sign.querySelector('[data-buddy]');
    // M on the sign, at its end, pointing at the code.
    expect(buddy).toHaveAttribute('data-scene', 'nudge');
    expect(buddy?.querySelector('[data-art="wallet"]')).toHaveAttribute('data-size', 'lg');
    const add = screen.getByRole('region', { name: HOLDER_COPY.addTitle });
    expect(within(add).getByText(HOLDER_COPY.scanLine)).toBeVisible();
    const badge = within(add).getByRole('link', { name: 'Add to Apple Wallet' });
    expect(badge.closest('.wl-way')).toHaveTextContent('Apple Wallet');
    expect(buddies()).toHaveLength(1);
  });

  it('iPhone: the badge’s card leads the page, the buddy on it pointing at the badge', async () => {
    const { container } = await open(IPHONE);
    const add = screen.getByRole('region', { name: HOLDER_COPY.addTitle });
    const card = within(add).getByRole('link', { name: 'Add to Apple Wallet' }).parentElement;
    expect(card?.querySelector(':scope > [data-buddy]')).toHaveAttribute('data-scene', 'nudge');
    // The card comes before the pass on a phone (holder-pass.css), so the badge is on screen.
    expect(container.querySelector('.wl-holder')).toHaveAttribute('data-lead', 'add');
    expect(document.querySelector(`img[alt="${QR}"]`)).toBeNull();
    expect(buddies()).toHaveLength(1);
  });

  it('iPhone in an app’s web view: the card says to open Safari', async () => {
    await open(IN_APP);
    const add = screen.getByRole('region', { name: HOLDER_COPY.addTitle });
    expect(add).toHaveTextContent(HOLDER_COPY.openInSafari);
  });

  it('in Apple Wallet: a quiet line under the happy buddy; Show QR opens adding again', async () => {
    const user = userEvent.setup();
    await open(MAC, { inWallet: true });
    const add = screen.getByRole('region', { name: HOLDER_COPY.added });
    expect(within(add).getByText(HOLDER_COPY.addedLine)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    const show = within(add).getByRole('button', { name: HOLDER_COPY.showQr });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await user.click(show);
    expect(add.contains(await qrImage())).toBe(true);
    expect(within(add).getByRole('link', { name: 'Add to Apple Wallet' })).toBeVisible();
    expect(within(add).getByRole('button', { name: HOLDER_COPY.hideQr })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // The happy buddy stays on the line; the sign comes back without one.
    expect(buddies().map((b) => b.dataset.scene)).toEqual(['count']);
  });

  it('in Apple Wallet on the iPhone: the pass leads; Add to this iPhone brings the badge back', async () => {
    const user = userEvent.setup();
    const { container } = await open(IPHONE, { inWallet: true });
    expect(container.querySelector('.wl-holder')).not.toHaveAttribute('data-lead');
    const add = screen.getByRole('region', { name: HOLDER_COPY.added });
    await user.click(within(add).getByRole('button', { name: HOLDER_COPY.addHere }));
    expect(within(add).getByRole('link', { name: 'Add to Apple Wallet' })).toBeVisible();
  });

  it('expired: the note, the buddy sad on it, nothing to add', async () => {
    await open(MAC, { passJson: { ...passFixture().passJson, expirationDate: '2020-01-01' } });
    expect(screen.getByText(HOLDER_COPY.expired)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    const [buddy] = buddies();
    expect(buddy?.closest('.wl-add-seat')).not.toBeNull();
    expect(buddy?.querySelector('[data-art="wallet"]')).toHaveAttribute('data-state', 'expired');
    expect(screen.getAllByText('Expired').length).toBeGreaterThan(0);
  });
});
