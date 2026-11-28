/** Contract fixtures: compiled bodies and documented examples against Google's field shapes. */
import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../../template/baked-fixtures.ts';
import { loadFixtures } from '../contract-fixtures.ts';
import { NOW } from '../view-fixtures.ts';
import { GOOGLE_COMPILERS } from './compilers.ts';
import { googleView } from './fixtures.ts';
import { GOOGLE_SHAPES } from './shapes.ts';
import type { GoogleType } from './types.ts';

const TYPES = Object.keys(GOOGLE_COMPILERS) as GoogleType[];
const OPTIONS = { now: NOW, omit: [] };

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

describe('compiled bodies fit Google field shapes', () => {
  for (const slug of bakedSlugs())
    it(`${slug}: every type either fits or is not satisfied`, async () => {
      for (const art of [true, false]) {
        const view = await googleView(slug, { art });
        for (const type of TYPES) {
          const result = GOOGLE_COMPILERS[type].compile(view, OPTIONS);
          if (result.blocked) {
            expect(result.blocked.code, `${slug} ${type}`).toBe('TYPE_UNSATISFIED');
            continue;
          }
          const shape = GOOGLE_SHAPES[type];
          expect(
            shape.classBody.safeParse(result.classBody).error?.issues,
            `${slug} ${type} class`,
          ).toBeUndefined();
          expect(
            shape.objectBody.safeParse(result.objectBody).error?.issues,
            `${slug} ${type} object`,
          ).toBeUndefined();
        }
      }
    });
});

const IMAGE = {
  sourceUri: { uri: 'https://img.example/logo.png' },
  contentDescription: { defaultValue: { language: 'en', value: 'Logo' } },
};
const TEXT = (value: string) => ({ defaultValue: { language: 'en', value } });

/** The documented bodies (google-wallet.md section 1), one per type, with every optional part. */
const DOCUMENTED = {
  generic: {
    classBody: { multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES' },
    objectBody: {
      genericType: 'GENERIC_OTHER',
      cardTitle: TEXT('Henry'),
      header: TEXT('Alex'),
      subheader: TEXT('Member'),
      logo: IMAGE,
      wideLogo: IMAGE,
      heroImage: IMAGE,
      hexBackgroundColor: '#112233',
      state: 'ACTIVE',
      barcode: { type: 'QR_CODE', renderEncoding: 'UTF_8', value: 'A', alternateText: 'A' },
      validTimeInterval: {
        start: { date: '2030-01-01T00:00:00Z' },
        end: { date: '2031-01-01T00:00:00Z' },
      },
      textModulesData: [{ id: 'a', header: 'H', body: 'B' }],
      linksModuleData: { uris: [{ id: 'l', uri: 'tel:+1', description: 'Call' }] },
      imageModulesData: [{ id: 'thumbnail', mainImage: IMAGE }],
      messages: [{ id: 'm', header: 'H', body: 'B', messageType: 'TEXT' }],
      merchantLocations: [{ latitude: 1, longitude: 2 }],
      notifications: { upcomingNotification: { enableNotification: true } },
    },
  },
  event: {
    classBody: {
      multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
      issuerName: 'Hall',
      reviewStatus: 'UNDER_REVIEW',
      eventName: TEXT('Show'),
      venue: { name: TEXT('Hall'), address: TEXT('Main St') },
      dateTime: {
        start: '2030-06-01T19:00:00-07:00',
        end: '2030-06-01T22:00:00-07:00',
        doorsOpen: '2030-06-01T18:00:00-07:00',
      },
      eventId: 'E1',
      logo: IMAGE,
      wideLogo: IMAGE,
      heroImage: IMAGE,
      hexBackgroundColor: '#112233',
    },
    objectBody: {
      state: 'ACTIVE',
      ticketHolderName: 'Alex',
      ticketNumber: 'T1',
      reservationInfo: { confirmationCode: 'C1' },
      seatInfo: { seat: TEXT('14'), row: TEXT('A'), section: TEXT('S'), gate: TEXT('G') },
      locations: [{ latitude: 1, longitude: 2 }],
    },
  },
  loyalty: {
    classBody: {
      multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
      issuerName: 'Cafe',
      reviewStatus: 'UNDER_REVIEW',
      programName: 'Cafe',
      programLogo: IMAGE,
      wideProgramLogo: IMAGE,
      accountIdLabel: 'Member',
      accountNameLabel: 'Name',
    },
    objectBody: {
      state: 'ACTIVE',
      accountId: 'M1',
      accountName: 'Alex',
      loyaltyPoints: { label: 'Points', balance: { int: 12 } },
      secondaryLoyaltyPoints: {
        label: 'Credit',
        balance: { money: { micros: '25000000', currencyCode: 'USD' } },
      },
    },
  },
  gift: {
    classBody: {
      multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
      issuerName: 'Shop',
      reviewStatus: 'UNDER_REVIEW',
      merchantName: 'Shop',
      programLogo: IMAGE,
      cardNumberLabel: 'Card',
      pinLabel: 'PIN',
      balanceLabel: 'Balance',
    },
    objectBody: {
      state: 'ACTIVE',
      cardNumber: '4111',
      pin: '1234',
      balance: { micros: '1500000', currencyCode: 'EUR' },
    },
  },
  offer: {
    classBody: {
      multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
      issuerName: 'Shop',
      reviewStatus: 'UNDER_REVIEW',
      provider: 'Shop',
      title: '20% off',
      localizedTitle: {
        defaultValue: { language: 'en', value: '20% off' },
        translatedValues: [{ language: 'fr', value: '20 % de réduction' }],
      },
      redemptionChannel: 'BOTH',
      details: 'One per customer',
      finePrint: 'Terms',
      titleImage: IMAGE,
      wideTitleImage: IMAGE,
    },
    objectBody: { state: 'INACTIVE', locations: [{ latitude: 1, longitude: 2 }] },
  },
} as const;

describe('documented bodies', () => {
  for (const type of TYPES)
    it(`${type}: the documented class and object parse`, () => {
      expect(
        GOOGLE_SHAPES[type].classBody.safeParse(DOCUMENTED[type].classBody).error,
      ).toBeUndefined();
      expect(
        GOOGLE_SHAPES[type].objectBody.safeParse(DOCUMENTED[type].objectBody).error,
      ).toBeUndefined();
    });

  it('rejects a missing required field', () => {
    const { header: _header, ...noHeader } = DOCUMENTED.generic.objectBody;
    expect(GOOGLE_SHAPES.generic.objectBody.safeParse(noHeader).success).toBe(false);
    const { eventName: _name, ...noName } = DOCUMENTED.event.classBody;
    expect(GOOGLE_SHAPES.event.classBody.safeParse(noName).success).toBe(false);
    const { programLogo: _logo, ...noLogo } = DOCUMENTED.loyalty.classBody;
    expect(GOOGLE_SHAPES.loyalty.classBody.safeParse(noLogo).success).toBe(false);
    const { cardNumber: _card, ...noCard } = DOCUMENTED.gift.objectBody;
    expect(GOOGLE_SHAPES.gift.objectBody.safeParse(noCard).success).toBe(false);
    const { redemptionChannel: _channel, ...noChannel } = DOCUMENTED.offer.classBody;
    expect(GOOGLE_SHAPES.offer.classBody.safeParse(noChannel).success).toBe(false);
  });

  it('rejects a key Google does not know, 11 text modules, 11 locations and a pass-level id', () => {
    const generic = DOCUMENTED.generic.objectBody;
    const parse = (body: unknown) => GOOGLE_SHAPES.generic.objectBody.safeParse(body).success;
    expect(parse({ ...generic, extendedFields: '{}' })).toBe(false);
    expect(
      parse({
        ...generic,
        textModulesData: Array.from({ length: 11 }, (_, i) => ({ id: `m${i}`, body: 'x' })),
      }),
    ).toBe(false);
    expect(
      parse({
        ...generic,
        merchantLocations: Array.from({ length: 11 }, () => ({ latitude: 1, longitude: 2 })),
      }),
    ).toBe(false);
    expect(parse({ ...generic, id: 'issuer.o_x' })).toBe(false);
  });
});

describe('fixtures', () => {
  it('declares where every Google fixture came from, a doc-shape one with a note', () => {
    const all = loadFixtures('google');
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) {
      expect(['recorded', 'doc-shape'], f.name).toContain(f.provenance);
      if (f.provenance === 'doc-shape') expect(f.note, f.name).toBeTruthy();
    }
  });

  it('keeps the synthetic callback envelope marked doc-shape', () => {
    const [envelope] = loadFixtures('google', 'callback-envelope');
    expect(envelope?.provenance).toBe('doc-shape');
  });
});
