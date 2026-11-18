import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../../template/baked-fixtures.ts';
import { NOW } from '../view-fixtures.ts';
import { defaultType, GOOGLE_COMPILERS, googleCompiler } from './compilers.ts';
import { googleView } from './fixtures.ts';

const OPTIONS = { now: NOW, omit: [] };
const GIFT = {
  roles: {
    memberId: false,
    giftCardNumber: { value: '4111 0000 0000 0001' },
    giftCardPin: { value: '4821' },
  },
};

beforeAll(async () => {
  await loadBaked('starter-stamp-card'); // draws its strips once
}, 120_000);

describe('Google compilers over every starter and baked template', () => {
  for (const slug of bakedSlugs())
    it(`${slug}: the default type and Generic, with Google art`, async () => {
      const view = await googleView(slug);
      const type = defaultType(view);
      for (const t of new Set([type, 'generic'] as const))
        expect(GOOGLE_COMPILERS[t].compile(view, OPTIONS)).toMatchSnapshot(t);
      expect(googleCompiler.compile(view, OPTIONS).type).toBe(type);
    });

  for (const slug of bakedSlugs())
    it(`${slug}: with no Google art`, async () => {
      const view = await googleView(slug, { art: false });
      expect(googleCompiler.compile(view, OPTIONS)).toMatchSnapshot();
    });

  for (const slug of ['starter-store-card', 'starter-stamp-card'])
    it(`${slug}: a gift card when it has a card number and no member`, async () => {
      const view = await googleView(slug, { wallets: GIFT });
      expect(defaultType(view)).toBe('gift');
      expect(GOOGLE_COMPILERS.gift.compile(view, OPTIONS)).toMatchSnapshot();
    });
});

describe('type selection (architecture 3.1)', () => {
  const typeOf = async (slug: string, wallets?: Record<string, unknown>) =>
    googleCompiler.compile(await googleView(slug, { wallets }), OPTIONS).type;

  it('follows the Apple style', async () => {
    expect(await typeOf('starter-event-ticket')).toBe('event');
    expect(await typeOf('starter-store-card')).toBe('loyalty');
    expect(await typeOf('starter-coupon')).toBe('offer');
    expect(await typeOf('starter-generic')).toBe('generic');
    expect(await typeOf('starter-poster-generic')).toBe('generic');
    expect(await typeOf('starter-boarding-pass')).toBe('generic');
  });

  it('takes the author type, and off compiles nothing', async () => {
    expect(await typeOf('starter-store-card', { google: { type: 'generic' } })).toBe('generic');
    const off = googleCompiler.compile(
      await googleView('starter-coupon', { wallets: { google: { type: 'off' } } }),
      OPTIONS,
    );
    expect(off).toEqual({ type: 'off', items: [] });
  });

  it('falls back to Generic with a type omission when the roles are missing', async () => {
    const view = await googleView('starter-generic', { wallets: { google: { type: 'event' } } });
    const result = googleCompiler.compile(view, OPTIONS);
    expect(result.type).toBe('generic');
    expect(result.items.find((i) => i.capability === 'type')).toEqual({
      capability: 'type',
      path: '',
      support: 'omitted',
      message: 'Event ticket not used: An event ticket needs an event name and a start time.',
    });
  });

  it('is blocked, not downgraded, when the type is required', async () => {
    const view = await googleView('starter-generic', {
      wallets: { google: { type: 'offer' }, required: ['type'] },
    });
    const result = googleCompiler.compile(view, OPTIONS);
    expect(result.blocked?.code).toBe('TYPE_UNSATISFIED');
    expect(result.classBody).toBeUndefined();
  });

  it('falls back from a typed class that has no logo of its own size', async () => {
    const view = await googleView('starter-store-card', { art: false });
    const result = googleCompiler.compile(view, OPTIONS);
    expect(result.type).toBe('generic');
    expect(result.items.find((i) => i.capability === 'type')?.message).toBe(
      'Loyalty not used: Needs a logo of at least 660 x 660 px.',
    );
  });

  it('blocks a required role the pass has no value for', async () => {
    const view = await googleView('starter-generic', { wallets: { required: ['role.points'] } });
    expect(googleCompiler.compile(view, OPTIONS).blocked).toEqual({
      code: 'REQUIRED_ROLE_EMPTY',
      message: 'role.points has no value.',
    });
  });
});
