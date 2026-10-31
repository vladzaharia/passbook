import { describe, expect, it } from 'vitest';
import type { PassJson } from '../types.ts';
import { hexToRgb, normalizePass, stripDesignerIds } from './normalize.ts';

const base = (extra: Record<string, unknown> = {}) =>
  ({
    formatVersion: 1,
    passTypeIdentifier: 'pass.a',
    teamIdentifier: 'T',
    serialNumber: 's',
    organizationName: 'o',
    description: 'd',
    generic: { primaryFields: [{ key: 'a', value: 'b' }] },
    ...extra,
  }) as PassJson;

describe('stripDesignerIds', () => {
  it('removes _id at every depth but keeps issuer data in userInfo', () => {
    const out = stripDesignerIds({
      _id: '1',
      barcodes: [{ _id: '2', format: 'x' }],
      generic: { primaryFields: [{ _id: '3', key: 'k' }] },
      userInfo: { _id: 'keep', nested: { _id: 'keep' } },
    });
    expect(JSON.stringify(out)).not.toMatch(/"_id":"[123]"/);
    expect(out.userInfo).toEqual({ _id: 'keep', nested: { _id: 'keep' } });
  });
});

describe('hexToRgb', () => {
  it('converts short and long hex, leaves everything else', () => {
    expect(hexToRgb('#fff')).toBe('rgb(255, 255, 255)');
    expect(hexToRgb('#1A2b3C')).toBe('rgb(26, 43, 60)');
    expect(hexToRgb('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
    expect(hexToRgb('#12345')).toBe('#12345');
    expect(hexToRgb(5)).toBe(5);
  });
});

describe('normalizePass', () => {
  it('does not mutate its input', () => {
    const input = base({
      backgroundColor: '#000',
      generic: { primaryFields: [{ _id: 'x', key: 'a', value: 'b' }] },
    });
    const copy = structuredClone(input);
    normalizePass(input);
    expect(input).toEqual(copy);
  });

  it('converts colors, including seat section colors', () => {
    const out = normalizePass(
      base({ labelColor: '#f00', semantics: { seats: [{ seatSectionColor: '#00f' }] } }),
    );
    expect(out.labelColor).toBe('rgb(255, 0, 0)');
    expect(out.semantics?.seats?.[0]?.seatSectionColor).toBe('rgb(0, 0, 255)');
  });

  it('upper-cases RFC 3339 lowercase t and z in dates', () => {
    const out = normalizePass(
      base({
        expirationDate: '2027-01-31t23:59:00z',
        relevantDates: [
          { startDate: '2027-01-31t10:00:00z', endDate: '2027-01-31t11:00:00+01:00' },
        ],
        semantics: { eventStartDate: '2027-01-31t10:00:00z', eventName: 'tz' },
      }),
    );
    expect(out.expirationDate).toBe('2027-01-31T23:59:00Z');
    expect(out.relevantDates?.[0]).toMatchObject({
      startDate: '2027-01-31T10:00:00Z',
      endDate: '2027-01-31T11:00:00+01:00',
    });
    expect(out.semantics?.eventStartDate).toBe('2027-01-31T10:00:00Z');
    expect(out.semantics?.eventName).toBe('tz');
  });

  it('writes both single-moment keys and the root relevantDate', () => {
    const out = normalizePass(
      base({
        generic: undefined,
        eventTicket: { primaryFields: [{ key: 'a', value: 'b' }] },
        relevantDates: [{ date: '2026-12-01T10:00:00Z' }, { relevantDate: '2026-12-02T10:00:00Z' }],
      }),
    );
    expect(out.relevantDates).toEqual([
      { date: '2026-12-01T10:00:00Z', relevantDate: '2026-12-01T10:00:00Z' },
      { date: '2026-12-02T10:00:00Z', relevantDate: '2026-12-02T10:00:00Z' },
    ]);
    expect(out.relevantDate).toBe('2026-12-01T10:00:00Z');
  });

  it('uses startDate for the root relevantDate and keeps an existing one', () => {
    const range = [{ startDate: '2026-12-01T10:00:00Z', endDate: '2026-12-01T12:00:00Z' }];
    expect(normalizePass(base({ relevantDates: range })).relevantDate).toBe('2026-12-01T10:00:00Z');
    expect(
      normalizePass(base({ relevantDates: range, relevantDate: '2026-11-01T10:00:00Z' }))
        .relevantDate,
    ).toBe('2026-11-01T10:00:00Z');
  });

  it('adds no root relevantDate to coupons and store cards', () => {
    const out = normalizePass(
      base({
        generic: undefined,
        coupon: { primaryFields: [] },
        relevantDates: [{ date: '2026-12-01T10:00:00Z' }],
      }),
    );
    expect(out.relevantDate).toBeUndefined();
  });

  it('copies the root maxDistance to locations without one', () => {
    const out = normalizePass(
      base({
        maxDistance: 120,
        locations: [
          { latitude: 1, longitude: 2 },
          { latitude: 3, longitude: 4, maxDistance: 50 },
        ],
      }),
    );
    expect(out.locations?.map((l) => l.maxDistance)).toEqual([120, 50]);
  });

  it('defaults messageEncoding and recases Pass Builder remote image keys', () => {
    const out = normalizePass(
      base({
        barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x' }],
        upcomingPassInformation: [
          {
            identifier: 'a',
            name: 'n',
            type: 'event',
            images: {
              headerImage: { urls: [{ url: 'https://x.example/a.png', sha256: 'ab', size: 1 }] },
            },
          },
        ],
      }),
    );
    expect(out.barcodes?.[0]?.messageEncoding).toBe('iso-8859-1');
    expect(out.upcomingPassInformation?.[0]?.images?.headerImage).toEqual({
      URLs: [{ URL: 'https://x.example/a.png', SHA256: 'ab', size: 1 }],
    });
  });
});
