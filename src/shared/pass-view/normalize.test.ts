import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { resolveColors } from './color.ts';
import {
  assets,
  boardingPass,
  coupon,
  eventTicket,
  fixtures,
  generic,
  posterEventTicket,
  posterGeneric,
  storeCard,
} from './fixtures/index.ts';
import { resolveImages } from './images.ts';
import { facesDiffer, normalize } from './normalize.ts';

const now = new Date('2026-10-31T12:00:00Z');
const opts = { assets, now, timeZone: 'UTC' };

describe('style resolution', () => {
  it.each(['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass'] as const)(
    '%s',
    (name) => {
      const v = normalize(fixtures[name], opts);
      expect(v.style).toBe(name);
      expect(v.layouts.legacy.style).toBe(name);
      expect(v.hasAlternate).toBe(false);
    },
  );

  it('posterGeneric wins on iOS 27 and falls back to the legacy key', () => {
    const v = normalize(posterGeneric, opts);
    expect(v.style).toBe('posterGeneric');
    expect(v.layouts.ios27.style).toBe('posterGeneric');
    expect(v.layouts.legacy.style).toBe('generic');
    expect(v.hasAlternate).toBe(true);
    expect(normalize(posterGeneric, { ...opts, target: 'legacy' }).style).toBe('generic');
  });

  it('posterGeneric alone degrades to generic on older iOS', () => {
    const { generic: _g, ...only } = posterGeneric;
    const v = normalize(only as PassJson, opts);
    expect(v.layouts.legacy).toMatchObject({ style: 'generic', degraded: true });
    expect(v.layouts.legacy.primary[0]?.text).toBe('Ada Lovelace');
  });

  it('poster event ticket needs preferredStyleSchemes and iOS 27', () => {
    expect(normalize(eventTicket, opts).layout.poster).toBe(false);
    const v = normalize(posterEventTicket, opts);
    expect(v.layouts.ios27).toMatchObject({ style: 'eventTicket', poster: true });
    expect(v.layouts.legacy.poster).toBe(false);
    expect(v.hasAlternate).toBe(true);
  });

  it('a pass with no style yields an empty generic layout', () => {
    const v = normalize({ ...generic, generic: undefined }, opts);
    expect(v.style).toBe('generic');
    expect(v.layout.primary).toEqual([]);
  });
});

describe('fields', () => {
  it('formats and aligns fields', () => {
    const l = normalize(generic, opts).layout;
    expect(l.header[0]).toMatchObject({ label: 'Tier', text: 'Gold', align: 'right' });
    expect(l.secondary[0]).toMatchObject({ text: 'Mar 1, 2024', dateTime: '2024-03-01T00:00:00Z' });
    expect(l.auxiliary[0]?.[0]?.text).toBe('12,500');
  });

  it('localizes labels, values, org and logo text', () => {
    const v = normalize(generic, {
      ...opts,
      strings: { Gold: 'Or', Tier: 'Niveau', 'Example Org': 'Exemple', Example: 'Exemple SA' },
    });
    expect(v.layout.header[0]).toMatchObject({ label: 'Niveau', text: 'Or' });
    expect(v.organizationName).toBe('Exemple');
    expect(v.logoText).toBe('Exemple SA');
  });

  it('does not resolve prototype keys as strings', () => {
    const p = { ...generic, organizationName: 'constructor' };
    expect(normalize(p, { ...opts, strings: {} }).organizationName).toBe('constructor');
  });

  it('back fields linkify, attributedValue wins and detectors can be disabled', () => {
    const p: PassJson = {
      ...generic,
      generic: {
        backFields: [
          { key: 'a', value: 'x', attributedValue: 'see <a href="https://a.io">a</a>' },
          { key: 'b', value: 'mail me@a.io' },
          { key: 'c', value: 'mail me@a.io', dataDetectorTypes: [] },
          { key: 'd', value: 'bad', attributedValue: '<a href="javascript:alert(1)">bad</a>' },
        ],
      },
    };
    const [a, b, c, d] = normalize(p, opts).layout.back;
    expect(a?.segments).toEqual([{ text: 'see ' }, { text: 'a', href: 'https://a.io/' }]);
    expect(b?.segments.some((s) => s.href === 'mailto:me@a.io')).toBe(true);
    expect(c?.segments).toEqual([{ text: 'mail me@a.io' }]);
    expect(d?.segments).toEqual([{ text: 'bad' }]);
  });

  it('front fields are not linkified', () => {
    const p: PassJson = {
      ...generic,
      generic: { primaryFields: [{ key: 'a', value: 'me@a.io' }] },
    };
    expect(normalize(p, opts).layout.primary[0]?.segments).toEqual([{ text: 'me@a.io' }]);
  });

  it('skips malformed field entries', () => {
    const p = {
      ...generic,
      generic: { primaryFields: [null, 3, { key: 'ok', value: 'v' }] },
    } as unknown as PassJson;
    expect(normalize(p, opts).layout.primary.map((f) => f.key)).toEqual(['ok']);
  });

  it('collects formatting warnings without throwing', () => {
    const p: PassJson = {
      ...generic,
      generic: { primaryFields: [{ key: 'm', value: 5, currencyCode: '??' }] },
    };
    expect(normalize(p, opts).warnings).toEqual(['field.currency.invalid:m']);
    expect(normalize(generic, { ...opts, locale: '!!' }).warnings).toContain('locale.invalid');
  });
});

const many = (n: number, prefix = 'k') =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, value: `v${i}` }));

describe('display limits', () => {
  it('generic keeps 3 header, 1 primary, 4 secondary; the rest goes to overflow', () => {
    const p = {
      ...generic,
      generic: { headerFields: many(5), primaryFields: many(2), secondaryFields: many(6) },
    } as PassJson;
    const l = normalize(p, opts).layout;
    expect([l.header.length, l.primary.length, l.secondary.length]).toEqual([3, 1, 4]);
    expect(l.overflow.length).toBe(2 + 1 + 2);
  });

  it('storeCard and coupon merge secondary and auxiliary into one row of 4', () => {
    for (const pass of [storeCard, coupon]) {
      const p = {
        ...pass,
        [pass === storeCard ? 'storeCard' : 'coupon']: {
          secondaryFields: many(3),
          auxiliaryFields: many(3),
        },
      } as PassJson;
      const l = normalize(p, opts).layout;
      expect(l.secondary.length).toBe(4);
      expect(l.auxiliary).toEqual([]);
      expect(l.overflow.length).toBe(2);
    }
  });

  it('eventTicket splits auxiliary rows', () => {
    const l = normalize(eventTicket, opts).layout;
    expect(l.auxiliary.map((r) => r.map((f) => f.key))).toEqual([['sec'], ['seat']]);
  });

  it('boardingPass allows 2 primary and 5 auxiliary', () => {
    const p = {
      ...boardingPass,
      boardingPass: {
        transitType: 'PKTransitTypeAir',
        primaryFields: many(3),
        auxiliaryFields: many(6),
      },
    } as PassJson;
    const l = normalize(p, opts).layout;
    expect([l.primary.length, l.auxiliary[0]?.length]).toEqual([2, 5]);
  });

  it('posterGeneric shows 1 header, up to 4 primary, 2 footers and hides secondary', () => {
    const p = {
      ...posterGeneric,
      posterGeneric: {
        headerFields: many(2),
        primaryFields: many(6),
        secondaryFields: many(1),
        footerFields: many(3),
      },
    } as PassJson;
    const l = normalize(p, opts).layout;
    expect([l.header.length, l.primary.length, l.secondary.length, l.footer.length]).toEqual([
      1, 4, 0, 2,
    ]);
    expect(l.overflow.length).toBe(1 + 2 + 1 + 1);
  });

  it('keeps back and additional info whole', () => {
    const l = normalize(posterGeneric, opts).layout;
    expect(l.back.length).toBe(2);
    expect(l.additionalInfo[0]?.text).toBe('6am to 10pm');
  });
});

describe('barcode', () => {
  it('picks the first format the target supports', () => {
    expect(normalize(posterGeneric, opts).layouts.ios27.barcode?.format).toBe(
      'PKBarcodeFormatCode39',
    );
    expect(normalize(posterGeneric, opts).layouts.legacy.barcode?.format).toBe('PKBarcodeFormatQR');
  });

  it('carries altText and shape', () => {
    expect(normalize(generic, opts).layout.barcode).toMatchObject({
      bcid: 'qrcode',
      square: true,
      altText: 'MEMBER-0001',
    });
    expect(normalize(storeCard, opts).layout.barcode).toMatchObject({
      bcid: 'pdf417',
      square: false,
    });
  });

  it('skips unknown formats and empty messages; none when nothing usable', () => {
    const p: PassJson = {
      ...generic,
      barcodes: [
        { format: 'PKBarcodeFormatNope', message: 'x', messageEncoding: 'utf-8' },
        { format: 'PKBarcodeFormatQR', message: '', messageEncoding: 'utf-8' },
      ],
    };
    expect(normalize(p, opts).layout.barcode).toBeUndefined();
  });

  it('falls back to the legacy barcode key', () => {
    const p = {
      ...generic,
      barcodes: undefined,
      barcode: { format: 'PKBarcodeFormatQR', message: 'L', messageEncoding: 'utf-8' },
    } as PassJson;
    expect(normalize(p, opts).layout.barcode?.message).toBe('L');
  });
});

describe('state', () => {
  it('flags voided and expired', () => {
    expect(normalize(generic, opts).invalid).toBeNull();
    expect(normalize({ ...generic, voided: true }, opts)).toMatchObject({
      voided: true,
      invalid: 'voided',
    });
    const past = normalize({ ...generic, expirationDate: '2026-10-01T00:00:00Z' }, opts);
    expect(past).toMatchObject({ expired: true, invalid: 'expired' });
    expect(normalize({ ...generic, expirationDate: '2027-01-01T00:00:00Z' }, opts).expired).toBe(
      false,
    );
    expect(normalize({ ...generic, expirationDate: 'garbage' }, opts).expired).toBe(false);
  });
});

describe('featured actions and transit', () => {
  it('keeps two safe actions on iOS 27 only', () => {
    const v = normalize(posterGeneric, opts);
    expect(v.layouts.ios27.actions).toEqual([
      { identifier: 'a1', type: 'call', label: 'Call', href: 'tel:+15550109999' },
      { identifier: 'a2', type: 'place', label: 'Directions' },
    ]);
    expect(v.layouts.legacy.actions).toEqual([]);
  });

  it('drops unsafe action urls and hides actions on poster tickets', () => {
    const p = {
      ...generic,
      featuredActions: [{ identifier: 'x', type: 'shop', url: 'javascript:alert(1)' }],
    } as PassJson;
    expect(normalize(p, opts).layout.actions).toEqual([
      { identifier: 'x', type: 'shop', label: 'Shop' },
    ]);
    expect(normalize(posterEventTicket, opts).layouts.ios27.actions).toEqual([]);
  });

  it.each([
    ['PKTransitTypeAir', 'air'],
    ['PKTransitTypeTrain', 'train'],
    ['PKTransitTypeBoat', 'boat'],
    ['PKTransitTypeBus', 'bus'],
    ['PKTransitTypeGeneric', 'generic'],
    ['junk', 'generic'],
  ])('transit %s', (t, kind) => {
    const p = { ...boardingPass, boardingPass: { transitType: t } } as PassJson;
    expect(normalize(p, opts).layout.transit?.kind).toBe(kind);
  });

  it('only boarding passes have transit', () => {
    expect(normalize(generic, opts).layout.transit).toBeUndefined();
  });
});

describe('colors', () => {
  it('parses rgb and hex, defaults, and keeps contrast', () => {
    expect(resolveColors({ backgroundColor: 'rgb(0,0,0)', foregroundColor: '#fff' })).toMatchObject(
      {
        background: 'rgb(0, 0, 0)',
        foreground: 'rgb(255, 255, 255)',
        dark: true,
      },
    );
    expect(resolveColors({})).toMatchObject({
      background: 'rgb(255, 255, 255)',
      foreground: 'rgb(0, 0, 0)',
      dark: false,
    });
  });

  it('rejects malformed colors and keeps unreadable pairs as given', () => {
    expect(resolveColors({ backgroundColor: 'rgb(300,0,0)' }).background).toBe(
      'rgb(255, 255, 255)',
    );
    expect(resolveColors({ backgroundColor: 'url(javascript:1)' }).background).toBe(
      'rgb(255, 255, 255)',
    );
    expect(
      resolveColors({ backgroundColor: 'rgb(10,10,10)', foregroundColor: 'rgb(20,20,20)' })
        .foreground,
    ).toBe('rgb(20, 20, 20)');
  });

  it('derives a label color only when missing', () => {
    expect(resolveColors({ backgroundColor: 'rgb(0,0,0)', labelColor: 'rgb(1,1,1)' }).label).toBe(
      'rgb(1, 1, 1)',
    );
    expect(resolveColors({ backgroundColor: 'rgb(0,0,0)' }).label).not.toBe('rgb(0, 0, 0)');
    expect(resolveColors({ labelColor: 'rgb(100, 100, 100)' }).label).toBe('rgb(100, 100, 100)');
  });
});

describe('images', () => {
  it('builds src and srcset by slot', () => {
    const v = normalize(generic, opts);
    expect(v.images.logo).toEqual({
      slot: 'logo',
      src: '/a/logo.png',
      srcset: '/a/logo.png 1x, /a/logo@2x.png 2x, /a/logo@3x.png 3x',
    });
    expect(v.images.strip).toEqual({
      slot: 'strip',
      src: '/a/strip@2x.png',
      srcset: '/a/strip@2x.png 2x',
    });
    expect(v.images.thumbnail).toBeUndefined();
  });

  it('single 1x has no srcset', () => {
    expect(resolveImages({ 'icon.png': '/i.png' }, 'en').icon).toEqual({
      slot: 'icon',
      src: '/i.png',
    });
  });

  it('prefers top-level over localized files, then exact locale, then language', () => {
    const a = {
      'en.lproj/logo.png': '/en',
      'fr.lproj/logo.png': '/fr',
      'fr-CA.lproj/logo.png': '/frca',
    };
    expect(resolveImages(a, 'fr-CA').logo?.src).toBe('/frca');
    expect(resolveImages(a, 'fr-BE').logo?.src).toBe('/fr');
    expect(resolveImages(a, 'de').logo?.src).toBe('/en');
    expect(resolveImages({ ...a, 'logo.png': '/root' }, 'fr').logo?.src).toBe('/root');
  });

  it('drops unsafe urls and unknown files', () => {
    const out = resolveImages(
      {
        'logo.png': 'javascript:alert(1)',
        'icon.png': 'http://a.io/i.png',
        'strip.png': '//evil/x.png',
        'x.png': '/x',
        'artwork.jpg': '/a',
      },
      'en',
    );
    expect(out).toEqual({});
    expect(resolveImages({ 'icon.png': 'data:image/png;base64,AAAA' }, 'en').icon).toBeDefined();
  });
});

describe('other keys', () => {
  it('exposes locations, relevantDate and header darkening', () => {
    const p = {
      ...generic,
      suppressHeaderDarkening: true,
      relevantDate: '2026-11-01T00:00:00Z',
      locations: [{ latitude: 1, longitude: 2, relevantText: 'Here' }, { latitude: 'x' }],
    } as unknown as PassJson;
    const v = normalize(p, opts);
    expect(v.suppressHeaderDarkening).toBe(true);
    expect(v.relevantDate).toBe('2026-11-01T00:00:00Z');
    expect(v.locations).toEqual([{ latitude: 1, longitude: 2, relevantText: 'Here' }]);
  });
});

describe('truthful previews', () => {
  const henrysBlue = JSON.parse(
    readFileSync(join(process.cwd(), 'templates/henrys-blue/pass.json'), 'utf8'),
  ) as PassJson;

  it("draws Henry's blue as a generic pass with Code128 on iOS 26 and earlier", () => {
    const v = normalize(henrysBlue, { ...opts, target: 'legacy' });
    expect(v.style).toBe('generic');
    expect(v.layout.barcode?.format).toBe('PKBarcodeFormatCode128');
    expect(facesDiffer(v)).toBe(true);
  });

  it('keeps an NFC poster event ticket a poster on iOS 26 and earlier', () => {
    const nfc = { ...posterEventTicket, nfc: { message: 'X', encryptionPublicKey: 'K' } };
    expect(normalize(nfc, { ...opts, target: 'legacy' }).layout.poster).toBe(true);
    expect(normalize(posterEventTicket, { ...opts, target: 'legacy' }).layout.poster).toBe(false);
  });

  it('caps generic secondary plus auxiliary at four and lists the rest', () => {
    const p = {
      ...generic,
      generic: { secondaryFields: many(3), auxiliaryFields: many(3, 'a') },
    } as PassJson;
    const l = normalize(p, opts).layout;
    expect(l.secondary.length + l.auxiliary.flat().length).toBe(4);
    expect(l.overflow).toHaveLength(2);
  });

  it('shows two posterGeneric footers', () => {
    const p = {
      ...posterGeneric,
      posterGeneric: { ...posterGeneric.posterGeneric, footerFields: many(2) },
    } as PassJson;
    expect(normalize(p, opts).layout.footer).toHaveLength(2);
  });

  it('draws front attributed values as plain text', () => {
    const p = {
      ...generic,
      generic: {
        primaryFields: [
          { key: 'p', value: 'Site', attributedValue: '<a href="https://example.com">Site</a>' },
        ],
      },
    } as PassJson;
    const [field] = normalize(p, opts).layout.primary;
    expect(field?.segments.every((s) => !s.href)).toBe(true);
  });

  it('lays a poster event ticket out from semantics, approximately', () => {
    const p = {
      ...posterEventTicket,
      semantics: { eventName: 'Harbor Lights', venueName: 'Pier 62', admissionLevel: 'VIP' },
    } as PassJson;
    const l = normalize(p, opts).layout;
    expect(l.semantic).toMatchObject({ kind: 'event', title: 'Harbor Lights', venue: 'Pier 62' });
    expect(l.approximate).toBe(true);
  });
});
