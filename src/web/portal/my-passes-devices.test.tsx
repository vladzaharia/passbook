import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '../lib/test-utils.tsx';
import { canAddToWallet, isApplePhone } from './device.ts';
import { passFixture } from './fixtures.ts';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36';

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

describe('device rule', () => {
  it('knows which devices add passes; iPad is not an iPhone', () => {
    expect(canAddToWallet({ userAgent: IPHONE })).toBe(true);
    expect(canAddToWallet({ userAgent: MAC, maxTouchPoints: 0 })).toBe(true);
    expect(canAddToWallet({ userAgent: MAC, maxTouchPoints: 5 })).toBe(false);
    expect(canAddToWallet({ userAgent: WINDOWS })).toBe(false);
    expect(isApplePhone({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe(
      false,
    );
  });

  it.each([
    ['iPhone', IPHONE, 0, false],
    ['iPad', MAC, 5, true],
    ['Chrome on Windows', WINDOWS, 0, true],
  ])('%s: badge always, Show QR only where it cannot add', async (_n, ua, touch, qr) => {
    as(ua, touch);
    await renderApp('/', { handlers: { '/api/v1/me/passes': () => list(passFixture()) } });
    expect(await screen.findByRole('link', { name: 'Add to Apple Wallet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show QR' }) !== null).toBe(qr);
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
