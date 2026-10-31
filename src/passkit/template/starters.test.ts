import { beforeAll, describe, expect, it } from 'vitest';
import type { PassBuildError } from '../build.ts';
import { createFixtureIdentity } from '../testing/fixture-identity.ts';
import type { PassField, PassJson, Personalization, SigningMaterial } from '../types.ts';
import { buildBaked as build, freezeNow, loadBaked } from './baked-fixtures.ts';
import { pngSize } from './package.ts';

let material: SigningMaterial;
beforeAll(async () => {
  material = await createFixtureIdentity();
  freezeNow();
});

const STYLE_OF: Record<string, string> = {
  'starter-generic': 'generic',
  'starter-poster-generic': 'posterGeneric',
  'starter-store-card': 'storeCard',
  'starter-coupon': 'coupon',
  'starter-event-ticket': 'eventTicket',
  'starter-boarding-pass': 'boardingPass',
};

const groups = (pass: PassJson, style: string) =>
  Object.entries((pass[style] as Record<string, unknown>) ?? {})
    .filter(([, v]) => Array.isArray(v))
    .map(([k]) => k);
const keys = (pass: PassJson, style: string) =>
  Object.values((pass[style] as Record<string, unknown>) ?? {}).flatMap((v) =>
    Array.isArray(v) ? (v as PassField[]).map((f) => f.key) : [],
  );

describe.each(Object.entries(STYLE_OF))('%s', (slug, style) => {
  it('is platform-level with neutral branding', async () => {
    const { template } = await loadBaked(slug);
    expect(template.manifest.org).toBeUndefined();
    expect(JSON.stringify(template.passJson)).not.toMatch(/henry/i);
    expect(template.passJson.organizationName).toBe('Wallet');
    expect(template.styles).toContain(style);
  });

  it('builds the sample with no validation issues', async () => {
    const built = await build(slug, material);
    // Two primary fields are valid on boarding passes; the foundation validator counts one.
    // The event starter is barcode-only: poster layout needs NFC, which starters never carry.
    const issues = built.report.issues.filter(
      (i) =>
        !(i.code === 'FIELD_COUNT' && i.path === 'boardingPass.primaryFields') &&
        !(i.code === 'PET_NFC' && slug === 'starter-event-ticket'),
    );
    expect(issues).toEqual([]);
  });

  it('has an image of the right pixel size for every scale it ships', async () => {
    const { pkg } = await loadBaked(slug);
    const points: Record<string, [number, number]> = {
      icon: [38, 38],
      logo: [160, 50],
      primaryLogo: [126, 30],
      secondaryLogo: [135, 12],
      thumbnail: [90, 90],
      strip: slug === 'starter-event-ticket' ? [375, 98] : [375, 144],
      artwork: [358, 448],
      footer: [286, 15],
    };
    const images = pkg.assets.filter((a) => a.slot !== 'strings' && a.slot !== 'other');
    expect(images.length).toBeGreaterThan(0);
    for (const a of images) {
      const [w, h] = points[a.slot] as [number, number];
      expect([a.width, a.height], a.name).toEqual([w * a.scale, h * a.scale]);
      expect(pngSize(pkg.bytes[a.name] as Uint8Array)).toEqual({
        width: a.width,
        height: a.height,
      });
    }
    for (const slot of new Set(images.map((a) => a.slot)))
      expect(images.filter((a) => a.slot === slot).map((a) => a.scale)).toEqual([1, 2, 3]);
  });

  it('uses only slots its style draws', async () => {
    const { pkg } = await loadBaked(slug);
    const used = new Set(pkg.assets.map((a) => a.slot));
    expect(used.has('icon')).toBe(true);
    expect(used.has('background')).toBe(false);
  });

  it('removes an empty note and never leaks sample text into it', async () => {
    const { template } = await loadBaked(slug);
    const without = await build(slug, material, { ...template.manifest.sample, note: '' });
    expect(keys(without.passJson, style).filter((k) => k.startsWith('note'))).toEqual([]);
    const withNote = await build(slug, material, { ...template.manifest.sample, note: 'Hello' });
    const fields = (Object.values(withNote.passJson[style] as object).flat() as PassField[]).filter(
      (f) => typeof f === 'object',
    );
    expect(fields.find((f) => f.key.startsWith('note'))?.value).toBe('Hello');
  });

  it('rejects input that misses required fields', async () => {
    const error = await build(slug, material, {}).catch((e: unknown) => e);
    expect((error as PassBuildError).code).toBe('INVALID_INPUT');
    expect((error as PassBuildError).report.issues.length).toBeGreaterThan(0);
  });
});

describe('field coverage', () => {
  it('generic and poster use every group their style allows', async () => {
    const generic = (await build('starter-generic', material)).passJson;
    expect(groups(generic, 'generic')).toEqual(
      expect.arrayContaining([
        'headerFields',
        'primaryFields',
        'secondaryFields',
        'auxiliaryFields',
        'backFields',
      ]),
    );
    const poster = (await build('starter-poster-generic', material)).passJson;
    expect(groups(poster, 'posterGeneric')).toEqual(
      expect.arrayContaining([
        'headerFields',
        'primaryFields',
        'footerFields',
        'additionalInfoFields',
        'backFields',
      ]),
    );
    expect(poster.preferredStyleSchemes).toBeUndefined();
    expect(groups(poster, 'generic').length).toBeGreaterThan(0);
  });

  it('keeps field keys unique across the whole pass', async () => {
    for (const slug of Object.keys(STYLE_OF)) {
      const pass = (await build(slug, material)).passJson;
      const all = [
        'generic',
        'posterGeneric',
        'storeCard',
        'coupon',
        'eventTicket',
        'boardingPass',
      ].flatMap((s) => keys(pass, s));
      expect(new Set(all).size, slug).toBe(all.length);
    }
  });

  it('ships a barcode with altText on every starter', async () => {
    for (const slug of Object.keys(STYLE_OF)) {
      const { barcodes } = (await build(slug, material)).passJson;
      expect(barcodes?.length, slug).toBeGreaterThan(0);
      expect(
        barcodes?.every((b) => b.altText === b.message),
        slug,
      ).toBe(true);
    }
  });
});

describe('starter-generic', () => {
  it('builds wifi semantics only with both network and password', async () => {
    const { template } = await loadBaked('starter-generic');
    const sample = template.manifest.sample;
    const full = (await build('starter-generic', material, sample)).passJson;
    expect(full.semantics).toEqual({ wifiAccess: [{ ssid: 'Guest', password: 'change-me' }] });
    const { wifiSsid: _s, wifiPassword: _p, ...rest } = sample;
    expect((await build('starter-generic', material, rest)).passJson.semantics).toBeUndefined();
    const half = await build('starter-generic', material, { ...rest, wifiSsid: 'x' }).catch(
      (e: unknown) => e,
    );
    expect((half as PassBuildError).code).toBe('INVALID_INPUT');
  });

  it('omits expiry unless given and applies it when given', async () => {
    const plain = (await build('starter-generic', material, { holder: 'A', memberId: 'B' }))
      .passJson;
    expect(plain.expirationDate).toBeUndefined();
    const dated = (
      await build('starter-generic', material, {
        holder: 'A',
        memberId: 'B',
        expirationDate: '2031-01-01T00:00:00Z',
      })
    ).passJson;
    expect(dated.expirationDate).toBe('2031-01-01T00:00:00Z');
  });

  it('ships the call action and phone field only with a phone', async () => {
    const { template } = await loadBaked('starter-generic');
    const sample = template.manifest.sample;
    const plain = (await build('starter-generic', material, sample)).passJson;
    expect(plain.featuredActions?.map((a) => a.identifier)).toEqual(['portal']);
    expect(keys(plain, 'generic')).not.toContain('phone');
    const withPhone = (
      await build('starter-generic', material, { ...sample, phone: '+14155550100' })
    ).passJson;
    expect(withPhone.featuredActions?.find((a) => a.identifier === 'support')?.url).toBe(
      'tel:+14155550100',
    );
    expect(keys(withPhone, 'generic')).toContain('phone');
    expect(JSON.stringify(withPhone)).not.toContain('555 555 0100');
  });

  it('rejects a malformed phone', async () => {
    const { template } = await loadBaked('starter-generic');
    const error = await build('starter-generic', material, {
      ...template.manifest.sample,
      phone: '555-0100',
    }).catch((e: unknown) => e);
    expect((error as PassBuildError).code).toBe('INVALID_INPUT');
  });
});

describe('relevance locations', () => {
  const LOCATED: [string, string, string][] = [
    ['starter-coupon', 'storeLat', 'storeLng'],
    ['starter-store-card', 'storeLat', 'storeLng'],
    ['starter-generic', 'officeLat', 'officeLng'],
    ['starter-poster-generic', 'officeLat', 'officeLng'],
    ['starter-event-ticket', 'venueLat', 'venueLng'],
  ];

  it.each(LOCATED)('%s has no location unless coordinates are given', async (slug, lat, lng) => {
    const { template } = await loadBaked(slug);
    const { [lat]: _a, [lng]: _b, ...rest } = template.manifest.sample;
    const bare = (await build(slug, material, rest)).passJson;
    expect(bare.locations).toBeUndefined();
    const placed = (await build(slug, material, { ...rest, [lat]: 40.75, [lng]: -73.99 })).passJson;
    expect(placed.locations).toEqual([
      expect.objectContaining({ latitude: 40.75, longitude: -73.99 }),
    ]);
  });

  it('requires both coordinates', async () => {
    const error = await build('starter-coupon', material, {
      offer: 'x',
      code: 'y',
      expirationDate: '2031-01-01T00:00:00Z',
      storeLat: 1,
    }).catch((e: unknown) => e);
    expect((error as PassBuildError).code).toBe('INVALID_INPUT');
  });
});

describe('starter-store-card shop link', () => {
  it('uses the shop link as given and drops the action without one', async () => {
    const base = { holder: 'A', cardNumber: 'C', website: 'https://acme.test' };
    const none = (await build('starter-store-card', material, base)).passJson;
    expect(none.featuredActions?.map((a) => a.identifier)).toEqual(['top-up']);
    const shop = (
      await build('starter-store-card', material, { ...base, shopURL: 'https://shop.acme.test/x' })
    ).passJson;
    expect(shop.featuredActions?.find((a) => a.identifier === 'shop')?.url).toBe(
      'https://shop.acme.test/x',
    );
  });
});

describe('starter-store-card', () => {
  it('keeps the balance numeric in the field and a string in the semantics', async () => {
    const pass = (
      await build('starter-store-card', material, {
        holder: 'A',
        cardNumber: 'C',
        balance: 12.5,
        currency: 'EUR',
      })
    ).passJson;
    expect(pass.storeCard?.primaryFields?.[0]).toMatchObject({ value: 12.5, currencyCode: 'EUR' });
    expect(pass.semantics).toEqual({ balance: { amount: '12.5', currencyCode: 'EUR' } });
  });

  it('rejects a negative balance and unknown currency', async () => {
    const invalid: Personalization[] = [{ balance: -1 }, { currency: 'XXX' }];
    for (const bad of invalid) {
      const error = await build('starter-store-card', material, {
        holder: 'A',
        cardNumber: 'C',
        ...bad,
      }).catch((e: unknown) => e);
      expect((error as PassBuildError).code).toBe('INVALID_INPUT');
    }
  });
});

describe('starter-event-ticket', () => {
  it('declares the poster scheme with the classic fallback and the semantics it needs', async () => {
    const pass = (await build('starter-event-ticket', material)).passJson;
    expect(pass.preferredStyleSchemes).toEqual(['posterEventTicket', 'eventTicket']);
    expect(Object.keys(pass.semantics as object)).toEqual(
      expect.arrayContaining([
        'eventName',
        'venueName',
        'venueRegionName',
        'venueRoom',
        'eventStartDate',
      ]),
    );
    expect(pass.relevantDates).toEqual([
      { date: '2030-06-01T19:00:00Z', relevantDate: '2030-06-01T19:00:00Z' },
    ]);
    expect(pass.relevantDate).toBe('2030-06-01T19:00:00Z');
  });

  it('drops the venue location when coordinates are missing and follows input times', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    const { venueLat: _a, venueLng: _b, ...rest } = template.manifest.sample;
    const input: Personalization = {
      ...rest,
      startsAt: '2031-01-01T10:00:00Z',
      endsAt: '2031-01-01T12:00:00Z',
    };
    const pass = (await build('starter-event-ticket', material, input)).passJson;
    expect((pass.semantics as Record<string, unknown>).venueLocation).toBeUndefined();
    expect(pass.relevantDates).toEqual([
      { date: '2031-01-01T10:00:00Z', relevantDate: '2031-01-01T10:00:00Z' },
    ]);
    expect(pass.expirationDate).toBe('2031-01-01T12:00:00Z');
    expect(pass.locations).toBeUndefined();
  });

  it('builds events longer than 24 hours and expires at the end', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    const built = await build('starter-event-ticket', material, {
      ...template.manifest.sample,
      startsAt: '2030-06-01T10:00:00Z',
      endsAt: '2030-06-03T22:00:00Z',
    });
    expect(built.passJson.relevantDates?.[0]).toMatchObject({ date: '2030-06-01T10:00:00Z' });
    expect(built.passJson.expirationDate).toBe('2030-06-03T22:00:00Z');
    expect(built.report.issues.filter((i) => i.code === 'RELEVANT_DATE_RANGE')).toEqual([]);
  });

  it('adds guide links only when given', async () => {
    const { template } = await loadBaked('starter-event-ticket');
    const sample = template.manifest.sample;
    const plain = (await build('starter-event-ticket', material, sample)).passJson;
    expect(plain.directionsInformationURL).toBeUndefined();
    const linked = (
      await build('starter-event-ticket', material, {
        ...sample,
        directionsURL: 'https://venue.test/map',
        parkingURL: 'https://venue.test/park',
      })
    ).passJson;
    expect(linked.directionsInformationURL).toBe('https://venue.test/map');
    expect(linked.parkingInformationURL).toBe('https://venue.test/park');
  });
});

describe('starter-boarding-pass', () => {
  it('declares air transit with the semantic scheme and the required semantics', async () => {
    const pass = (await build('starter-boarding-pass', material)).passJson;
    expect(pass.boardingPass?.transitType).toBe('PKTransitTypeAir');
    expect(pass.preferredStyleSchemes).toEqual(['semanticBoardingPass', 'boardingPass']);
    for (const key of [
      'airlineCode',
      'flightNumber',
      'departureAirportCode',
      'departureCityName',
      'departureLocationTimeZone',
      'destinationAirportCode',
      'destinationCityName',
      'destinationLocationTimeZone',
      'originalArrivalDate',
      'originalBoardingDate',
      'originalDepartureDate',
      'passengerName',
    ])
      expect((pass.semantics as Record<string, unknown>)[key], key).toBeDefined();
    expect((pass.semantics as Record<string, unknown>).flightNumber).toBe(100);
  });

  it('drops the semantic scheme for non-air transit', async () => {
    const { template } = await loadBaked('starter-boarding-pass');
    const pass = (
      await build('starter-boarding-pass', material, {
        ...template.manifest.sample,
        transitType: 'train',
      })
    ).passJson;
    expect(pass.boardingPass?.transitType).toBe('PKTransitTypeTrain');
    expect(pass.preferredStyleSchemes).toBeUndefined();
  });

  it('keeps airline semantics off other transit types', async () => {
    const { template } = await loadBaked('starter-boarding-pass');
    const sample = template.manifest.sample;
    const train = (
      await build('starter-boarding-pass', material, { ...sample, transitType: 'train' })
    ).passJson;
    const semantics = train.semantics as Record<string, unknown>;
    for (const key of [
      'airlineCode',
      'flightNumber',
      'departureAirportCode',
      'destinationAirportCode',
    ])
      expect(semantics[key], key).toBeUndefined();
    expect(semantics).toMatchObject({
      departureStationName: 'San Francisco',
      destinationStationName: 'New York',
      vehicleNumber: 'WA100',
    });
    expect(train.logoText).toBe('Wallet');
    expect(train.boardingPass?.headerFields?.[0]?.label).toBe('TRAIN');
    const air = (await build('starter-boarding-pass', material, sample)).passJson;
    expect((air.semantics as Record<string, unknown>).airlineCode).toBe('WA');
    expect(air.logoText).toBe('Wallet Air');
  });

  it('sets relevance, gate, seats and links from input', async () => {
    const { template } = await loadBaked('starter-boarding-pass');
    const pass = (
      await build('starter-boarding-pass', material, {
        ...template.manifest.sample,
        boardingGroup: '3',
        managementURL: 'https://air.test/manage',
      })
    ).passJson;
    expect(pass.relevantDates).toEqual([
      { date: '2030-06-01T08:00:00Z', relevantDate: '2030-06-01T08:00:00Z' },
    ]);
    expect(pass.semantics).toMatchObject({
      departureGate: 'B12',
      boardingGroup: '3',
      seats: [{ seatNumber: '14A' }],
    });
    expect(pass.managementURL).toBe('https://air.test/manage');
    const { seat: _s, gate: _g, ...rest } = template.manifest.sample;
    const bare = (await build('starter-boarding-pass', material, rest)).passJson;
    expect((bare.semantics as Record<string, unknown>).seats).toBeUndefined();
    expect((bare.semantics as Record<string, unknown>).departureGate).toBeUndefined();
    expect(bare.managementURL).toBeUndefined();
  });

  it('rejects malformed airport codes', async () => {
    const { template } = await loadBaked('starter-boarding-pass');
    const error = await build('starter-boarding-pass', material, {
      ...template.manifest.sample,
      origin: 'sfo',
    }).catch((e: unknown) => e);
    expect((error as PassBuildError).code).toBe('INVALID_INPUT');
  });
});
