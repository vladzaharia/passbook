import { screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { json, renderApp } from '../lib/test-utils.tsx';
import { loadBarcodeEngine } from '../pass-card/barcode-engine.ts';
import { passFixture } from './fixtures.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36';
const GSA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) GSA/350.0 Mobile/15E148 Safari/604.1';

const list = (...items: ReturnType<typeof passFixture>[]) => json({ items, nextCursor: null });

function as(userAgent: string, maxTouchPoints = 0) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  // jsdom has no maxTouchPoints.
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

// The QR encoder is a lazy chunk. Load it once up front so a QR renders on mount, not after a
// chunk fetch that races findBy's default wait under load.
beforeAll(async () => {
  await loadBarcodeEngine();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'maxTouchPoints');
});

describe('device rule (shared/device.ts)', () => {
  it.each([
    ['iPhone', IPHONE, 0, false, false],
    // A Mac adds with the badge; its QR waits in More (the pass page shows it).
    ['Mac', MAC, 0, false, false],
    ['iPad', MAC, 5, true, true],
    ['Chrome on Windows', WINDOWS, 0, true, true],
  ])(
    '%s: badge always; Show QR and the line where it cannot add',
    async (_n, ua, touch, qr, line) => {
      as(ua, touch);
      await renderApp('/', { handlers: { '/api/v1/me/passes': () => list(passFixture()) } });
      expect(await screen.findByRole('link', { name: 'Add to Apple Wallet' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show QR' }) !== null).toBe(qr);
      expect(screen.queryAllByText(HOLDER_COPY.openOnApple)).toHaveLength(line ? 1 : 0);
    },
  );

  it('sends an iPhone app web view to Safari, on the list and the pass', async () => {
    as(GSA);
    const handlers = {
      '/api/v1/me/passes': () => list(passFixture({ id: 'p1' })),
      '/api/v1/me/passes/p1': () => json(passFixture({ id: 'p1' })),
    };
    const first = await renderApp('/', { handlers });
    expect(await screen.findByText(HOLDER_COPY.openInSafari)).toBeInTheDocument();
    first.unmount();
    await renderApp('/passes/p1', { handlers });
    expect(await screen.findByText(HOLDER_COPY.openInSafari)).toBeInTheDocument();
    expect(screen.queryByText(HOLDER_COPY.openOnApple)).not.toBeInTheDocument();
    // The phone itself gets no QR to scan.
    expect(screen.queryByText(HOLDER_COPY.scanLine)).not.toBeInTheDocument();
  });

  it('leads with the QR off Apple’s devices: the scan opens the public page, no badge', async () => {
    as(WINDOWS);
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture({ id: 'p1' })) },
    });
    // The image, not the encoder's placeholder it replaces.
    expect(await screen.findByAltText(HOLDER_COPY.qrAlt('Gym membership'))).toBeVisible();
    expect(screen.getByText(HOLDER_COPY.scanLine)).toBeInTheDocument();
    // The badge cannot add here, so neither it nor its line shows.
    expect(screen.queryByRole('link', { name: 'Add to Apple Wallet' })).toBeNull();
    expect(screen.queryByText(HOLDER_COPY.openOnApple)).toBeNull();
  });
});

describe('in Wallet', () => {
  it('shows the pill instead of the badge and leaves the bundle', async () => {
    await renderApp('/', {
      handlers: {
        '/api/v1/me/passes': () =>
          list(
            passFixture({ id: 'p1', title: 'One', inWallet: true }),
            passFixture({ id: 'p2', title: 'Two' }),
            passFixture({ id: 'p3', title: 'Three' }),
          ),
      },
    });
    expect(await screen.findByText('In Wallet')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Add to Apple Wallet' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: /Add 2 passes/ })).toBeInTheDocument();
  });
});
