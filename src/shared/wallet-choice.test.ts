import { describe, expect, it } from 'vitest';
import { walletChoices } from './wallet-choice.ts';

const iphone = { device: 'iphone', inApp: false } as const;
const other = { device: 'other', inApp: false } as const;
const ids = (input: Parameters<typeof walletChoices>[0]) => walletChoices(input).map((c) => c.id);

describe('walletChoices', () => {
  it('leads with Apple on iPhone and Mac, the browser barcode after', () => {
    for (const device of [iphone, { device: 'mac', inApp: false } as const]) {
      const choices = walletChoices({ device, apple: true, browserHref: '/barcode' });
      expect(choices.map((c) => [c.id, c.recommended])).toEqual([
        ['apple', true],
        ['browser', false],
      ]);
    }
  });

  it("leads with Apple's QR on a computer, the browser barcode after it", () => {
    expect(ids({ device: other, apple: true, browserHref: '/barcode' })).toEqual([
      'apple',
      'browser',
    ]);
  });

  it('leads with the browser barcode on a computer while Apple is off', () => {
    expect(ids({ device: other, apple: false, browserHref: '/barcode' })).toEqual(['browser']);
  });

  it('never hides an eligible option, only a disabled provider', () => {
    const offers = [
      { provider: 'google', href: '/g' },
      { provider: 'samsung', href: '/s' },
    ] as const;
    expect(ids({ device: iphone, apple: true, offers })).toEqual(['apple', 'google', 'samsung']);
    expect(
      ids({
        device: other,
        apple: true,
        offers,
        issuance: { google: { state: 'disabled', reason: 'not_released' } },
      }),
    ).toEqual(['apple', 'samsung']);
  });

  it('offers nothing when the pass cannot be added', () => {
    expect(ids({ device: iphone, apple: false })).toEqual([]);
  });

  describe('Android', () => {
    const pixel = { device: 'android', inApp: false } as const;
    const galaxy = { device: 'galaxy', inApp: false } as const;
    const offers = [
      { provider: 'google', href: '/g' },
      { provider: 'samsung', href: '/s' },
    ] as const;

    it('leads with the browser barcode while the native wallets are dark, Apple last', () => {
      for (const device of [pixel, galaxy]) {
        expect(ids({ device, apple: true, browserHref: '/barcode' })).toEqual(['browser', 'apple']);
      }
    });

    it('prefers Google on Android and Samsung then Google on a Galaxy', () => {
      const input = { apple: true, browserHref: '/barcode', offers };
      expect(ids({ device: pixel, ...input })).toEqual(['google', 'browser', 'samsung', 'apple']);
      expect(ids({ device: galaxy, ...input })).toEqual(['samsung', 'google', 'browser', 'apple']);
    });

    it('shows a Galaxy holder Google and no Samsung trace while Samsung is disabled', () => {
      const choices = ids({
        device: galaxy,
        apple: true,
        browserHref: '/barcode',
        offers,
        issuance: { samsung: { state: 'disabled', reason: 'not_released' } },
      });
      expect(choices).toEqual(['google', 'browser', 'apple']);
    });
  });
});
