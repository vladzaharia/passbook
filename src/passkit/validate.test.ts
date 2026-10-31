import { describe, expect, it } from 'vitest';
import { NFC_KEY } from './schema/fixtures.ts';
import type { PassIdentity, PassJson } from './types.ts';
import { validatePass } from './validate.ts';

const identity: PassIdentity = { passTypeIdentifier: 'pass.a', teamIdentifier: 'TEAM' };
const icon = [{ name: 'icon.png' }];
const base = (extra: Record<string, unknown> = {}): PassJson =>
  ({
    formatVersion: 1,
    passTypeIdentifier: 'pass.a',
    teamIdentifier: 'TEAM',
    serialNumber: 's',
    organizationName: 'o',
    description: 'd',
    generic: { primaryFields: [{ key: 'a', value: 'b' }] },
    ...extra,
  }) as PassJson;
const codes = (pass: PassJson, assets = icon, id = identity) =>
  validatePass(pass, assets, id).issues.map((i) => `${i.severity}:${i.code}`);

describe('validatePass', () => {
  it('accepts a minimal pass', () => {
    expect(validatePass(base(), icon, identity)).toEqual({ ok: true, issues: [] });
  });

  it.each([
    ['missing style', { generic: undefined }, 'error:NO_STYLE'],
    ['identity mismatch', { teamIdentifier: 'OTHER' }, 'error:IDENTITY_MISMATCH'],
    ['bad color', { backgroundColor: '#fff' }, 'error:COLOR'],
    ['bad date', { expirationDate: 'tomorrow' }, 'error:DATE'],
    [
      'bad barcode',
      { barcodes: [{ format: 'nope', message: 'x', messageEncoding: 'utf-8' }] },
      'error:BARCODE_FORMAT',
    ],
    [
      'too many locations',
      { locations: Array.from({ length: 11 }, () => ({ latitude: 1, longitude: 1 })) },
      'error:LOCATIONS',
    ],
    ['nfc without entitlement', { nfc: { message: 'x' } }, 'error:NFC_NOT_ENTITLED'],
    ['three featured actions', { featuredActions: [{}, {}, {}] }, 'error:FEATURED_ACTIONS'],
    [
      'place action without place id',
      { featuredActions: [{ identifier: 'p', type: 'place', placeIdentifier: 'x' }] },
      'error:FEATURED_ACTIONS',
    ],
    ['unknown key', { futureKey: 1 }, 'warning:UNKNOWN_KEY'],
    [
      'bad attributedValue link',
      {
        generic: {
          backFields: [
            { key: 'x', value: '', attributedValue: '<a href="javascript:alert(1)">x</a>' },
          ],
        },
      },
      'error:LINK',
    ],
  ])('flags %s', (_name, extra, code) => {
    expect(codes(base(extra))).toContain(code);
  });

  it('allows https, tel and mailto links', () => {
    const pass = base({
      generic: {
        backFields: [
          {
            key: 'x',
            value: '',
            attributedValue:
              '<a href="https://a.co">a</a> <a href="tel:+1">t</a> <a href="mailto:a@b.co">m</a>',
          },
        ],
      },
    });
    expect(validatePass(pass, icon, identity).ok).toBe(true);
  });

  it('requires an icon and unique keys across the pass', () => {
    expect(codes(base(), [])).toContain('error:MISSING_ICON');
    const dup = base({
      generic: {
        primaryFields: [{ key: 'a', value: '1' }],
        backFields: [{ key: 'a', value: '2' }],
      },
    });
    expect(codes(dup)).toContain('error:DUPLICATE_FIELD_KEY');
  });

  it('accepts nfc for entitled identities and can treat warnings as errors', () => {
    expect(
      validatePass(base({ nfc: { message: 'x', encryptionPublicKey: NFC_KEY } }), icon, {
        ...identity,
        nfcEnabled: true,
      }).ok,
    ).toBe(true);
    expect(validatePass(base({ futureKey: 1 }), icon, identity, { strict: true }).ok).toBe(false);
  });
});
