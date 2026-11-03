import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLDER_COPY } from '@/shared/copy/holder.ts';
import { json, renderApp } from '../lib/test-utils.tsx';
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

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'maxTouchPoints');
});

describe('device rule (shared/device.ts)', () => {
  it.each([
    ['iPhone', IPHONE, 0, false, false],
    ['Mac', MAC, 0, true, false],
    ['iPad', MAC, 5, true, true],
    ['Chrome on Windows', WINDOWS, 0, true, true],
  ])(
    '%s: badge always, Show QR off the phone, the line where it cannot add',
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
    expect(screen.queryByText(HOLDER_COPY.scanQr)).not.toBeInTheDocument();
  });

  it('leads with the QR off the phone: the scan opens the public page, then the badge', async () => {
    as(WINDOWS);
    await renderApp('/passes/p1', {
      handlers: { '/api/v1/me/passes/p1': () => json(passFixture({ id: 'p1' })) },
    });
    const qr = await screen.findByRole('img', { name: HOLDER_COPY.qrAlt('Gym membership') });
    const badge = screen.getByRole('link', { name: 'Add to Apple Wallet' });
    expect(qr.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(HOLDER_COPY.openOnApple)).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: /All passes \(2\)/ })).toBeInTheDocument();
  });
});
