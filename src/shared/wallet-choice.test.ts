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

  it('leads with the browser barcode elsewhere and keeps Apple reachable', () => {
    expect(ids({ device: other, apple: true, browserHref: '/barcode' })).toEqual([
      'browser',
      'apple',
    ]);
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
});
