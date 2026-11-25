/** Where each role lands on each type (architecture 3.2). */
import { describe, expect, it } from 'vitest';
import type { RoleValue, WalletPassView, WalletRole } from '../types.ts';
import { NOW } from '../view-fixtures.ts';
import { GOOGLE_COMPILERS, googleCompiler } from './compilers.ts';
import { googleView } from './fixtures.ts';
import type { GoogleType } from './types.ts';

const text = (t: string): RoleValue => ({ kind: 'text', text: t, source: 'manifest', fields: [] });
const date = (iso: string): RoleValue => ({ kind: 'date', iso, source: 'manifest', fields: [] });
const set = (roles: Partial<Record<WalletRole, RoleValue>>) => (v: WalletPassView) => {
  Object.assign(v.roles, roles);
};
const compile = async (slug: string, type: GoogleType, patch?: (view: WalletPassView) => void) =>
  GOOGLE_COMPILERS[type].compile(await googleView(slug, { patch }), { now: NOW, omit: [] });
const object = (r: { objectBody?: unknown }) => r.objectBody as Record<string, any>;
const klass = (r: { classBody?: unknown }) => r.classBody as Record<string, any>;
const moduleBodies = (r: { objectBody?: unknown }) =>
  (object(r).textModulesData ?? []).map((m: { body: string }) => m.body);

describe('Event', () => {
  const roles = {
    doorsOpen: date('2030-06-01T18:00-07:00'),
    seat: text('14'),
    row: text('A'),
    section: text('Floor'),
    gate: text('3'),
    ticketNumber: text('T-100'),
    confirmationCode: text('CONF9'),
    eventId: text('EV-7'),
  };

  it('puts the event on the class and the seat and ticket on the object', async () => {
    const r = await compile('starter-event-ticket', 'event', set(roles));
    expect(klass(r)).toMatchObject({
      issuerName: 'PassBook',
      reviewStatus: 'UNDER_REVIEW',
      eventId: 'EV-7',
      eventName: { defaultValue: { value: 'Sample Event' } },
      venue: { name: { defaultValue: { value: 'Sample Hall' } } },
      dateTime: {
        start: '2030-06-01T19:00:00-07:00',
        end: '2030-06-01T22:00:00-07:00',
        doorsOpen: '2030-06-01T18:00:00-07:00',
      },
    });
    expect(object(r)).toMatchObject({
      ticketHolderName: 'Alex Morgan',
      ticketNumber: 'T-100',
      reservationInfo: { confirmationCode: 'CONF9' },
      seatInfo: {
        seat: { defaultValue: { value: '14' } },
        row: { defaultValue: { value: 'A' } },
        section: { defaultValue: { value: 'Floor' } },
        gate: { defaultValue: { value: '3' } },
      },
    });
  });

  it('does not repeat the event name as text', async () => {
    const r = await compile('starter-event-ticket', 'event');
    expect(moduleBodies(r)).not.toContain('Sample Event');
    expect(moduleBodies(r)).not.toContain('Alex Morgan');
  });

  it('carries the roles it has no slot for as text on Generic', async () => {
    const r = await compile('starter-event-ticket', 'generic', (v) => {
      v.fields = [];
      v.roles = { title: text('T'), ...roles };
    });
    expect(moduleBodies(r)).toEqual(expect.arrayContaining(['14', 'T-100', 'CONF9', 'EV-7']));
    expect(object(r).seatInfo).toBeUndefined();
  });

  it('is not satisfied without an event name and a start time', async () => {
    const r = await compile('starter-generic', 'event');
    expect(r.blocked).toEqual({
      code: 'TYPE_UNSATISFIED',
      message: 'An event ticket needs an event name and a start time.',
    });
  });
});

describe('Loyalty', () => {
  it('puts points and the balance in their own slots', async () => {
    const r = await compile(
      'starter-store-card',
      'loyalty',
      set({
        points: { kind: 'number', number: 120, text: '120', source: 'manifest', fields: [] },
        pointsLabel: text('Stars'),
      }),
    );
    expect(object(r)).toMatchObject({
      accountId: 'CARD-0001',
      loyaltyPoints: { label: 'Stars', balance: { int: 120 } },
      secondaryLoyaltyPoints: {
        label: 'Balance',
        balance: { money: { micros: '25000000', currencyCode: 'USD' } },
      },
    });
    expect(klass(r).programName).toBe('PassBook');
    expect(JSON.stringify(klass(r))).not.toContain('CARD-0001');
  });

  it('writes fractional and text points as they are', async () => {
    const half = await compile(
      'starter-store-card',
      'loyalty',
      set({ points: { kind: 'number', number: 2.5, text: '2.5', source: 'manifest', fields: [] } }),
    );
    expect(object(half).loyaltyPoints).toEqual({ label: 'Points', balance: { double: 2.5 } });
    const word = await compile(
      'starter-store-card',
      'loyalty',
      set({ points: text('Gold member') }),
    );
    expect(object(word).loyaltyPoints.balance).toEqual({ string: 'Gold member' });
  });

  it('keeps the tier a per-pass text module, never on the shared class', async () => {
    const r = await compile('starter-store-card', 'loyalty', set({ tier: text('Silver') }));
    expect(moduleBodies(r)).toContain('Silver');
    expect(JSON.stringify(klass(r))).not.toContain('Silver');
  });

  it('is replaced by Generic when the program has no logo', async () => {
    const view = await googleView('starter-store-card', { art: false });
    expect(googleCompiler.compile(view, { now: NOW, omit: [] }).type).toBe('generic');
  });
});

describe('Gift card', () => {
  it('carries the card, pin and balance natively', async () => {
    const r = await compile(
      'starter-store-card',
      'gift',
      set({
        giftCardNumber: text('4111'),
        giftCardPin: text('1234'),
        memberId: undefined as never,
      }),
    );
    expect(object(r)).toMatchObject({
      cardNumber: '4111',
      pin: '1234',
      balance: { micros: '25000000', currencyCode: 'USD' },
    });
    expect(klass(r)).toMatchObject({ merchantName: 'PassBook', balanceLabel: 'Balance' });
  });

  it('is not satisfied without a card number', async () => {
    expect((await compile('starter-store-card', 'gift')).blocked?.message).toBe(
      'A gift card needs a card number.',
    );
  });
});

describe('Offer', () => {
  it('puts the offer on the class', async () => {
    const r = await compile('starter-coupon', 'offer');
    expect(klass(r)).toMatchObject({
      provider: 'PassBook',
      title: '20% off',
      redemptionChannel: 'BOTH',
      details: 'One use per customer. Not combinable with other offers.',
    });
    expect(object(r).validTimeInterval).toEqual({ end: { date: '2030-01-01T00:00:00Z' } });
  });

  it('maps every redemption channel', async () => {
    for (const [channel, google] of [
      ['online', 'ONLINE'],
      ['instore', 'INSTORE'],
      ['both', 'BOTH'],
    ] as const) {
      const r = await compile(
        'starter-coupon',
        'offer',
        set({ redemptionChannel: { kind: 'channel', channel, source: 'manifest', fields: [] } }),
      );
      expect(klass(r).redemptionChannel).toBe(google);
    }
  });

  it('puts the start time in the interval and says how many dates it left out', async () => {
    const r = await compile('starter-coupon', 'offer', (v) => {
      v.roles.validFrom = date('2029-12-01T00:00:00Z');
      v.relevance.dates = [{ start: '2029-12-01T00:00:00Z' }, { start: '2029-12-15T00:00:00Z' }];
    });
    expect(object(r).validTimeInterval.start).toEqual({ date: '2029-12-01T00:00:00Z' });
    expect(r.items.find((i) => i.capability === 'relevance.dates')?.message).toBe(
      'Google carries the first start time only.',
    );
  });
});

describe('Generic', () => {
  it('uses one UTC offset for both ends of the interval', async () => {
    const r = await compile('starter-boarding-pass', 'generic');
    expect(object(r).validTimeInterval).toEqual({
      start: { date: '2030-06-01T15:00:00Z' },
      end: { date: '2030-06-01T20:30:00Z' },
    });
  });

  it('asks for a notification only when it has a relevant date', async () => {
    const withDate = await compile('starter-boarding-pass', 'generic', (v) => {
      v.relevance.dates = [{ start: '2030-06-01T13:15:00Z' }];
    });
    expect(object(withDate).notifications).toEqual({
      upcomingNotification: { enableNotification: true },
    });
    const without = await compile('starter-generic', 'generic');
    expect(object(without).notifications).toBeUndefined();
  });

  it('keeps per-pass values off the class', async () => {
    const r = await compile('starter-boarding-pass', 'generic');
    expect(klass(r)).toEqual({ multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES' });
  });

  it('reports NFC, personalization and beacons as unsupported', async () => {
    const r = await compile('starter-store-card', 'generic', (v) => {
      v.nfc = true;
      v.personalization = true;
    });
    expect(
      r.items
        .filter((i) => i.support === 'unsupported')
        .map((i) => i.capability)
        .sort(),
    ).toEqual(['nfc', 'personalization', 'relevance.beacons']);
  });
});
