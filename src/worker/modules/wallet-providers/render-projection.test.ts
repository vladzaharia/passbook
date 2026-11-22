import { describe, expect, it } from 'vitest';
import type { GoogleProjection } from './projection-contract.ts';
import { renderGoogleProjection } from './render-projection.ts';

const google: GoogleProjection = {
  schema: 1,
  provider: 'google',
  language: 'en',
  logoUrl: 'https://example.test/logo.png',
  sourceArtworkSlots: ['icon'],
  titleField: 'name',
  fields: ['name', 'member.number'],
  barcode: 'qr',
};
const pass = {
  formatVersion: 1,
  passTypeIdentifier: 'pass.private',
  teamIdentifier: 'team.private',
  serialNumber: 'private-serial',
  authenticationToken: 'secret-auth-token',
  webServiceURL: 'https://example.test/apple/private',
  organizationName: 'Cedar Gate',
  description: 'Member admission',
  generic: {
    primaryFields: [{ key: 'name', value: 'Alex Morgan', label: 'Member' }],
    secondaryFields: [{ key: 'member.number', value: 42, label: 'Number' }],
  },
  barcodes: [{ format: 'PKBarcodeFormatQR', message: 'SCAN-42', messageEncoding: 'utf-8' }],
};

describe('approved native projection rendering', () => {
  it('renders the approved Google values and QR without Apple credentials', () => {
    const result = renderGoogleProjection(google, pass);
    expect(result?.classProjection).toEqual({});
    expect(result?.objectProjection).toMatchObject({
      state: 'ACTIVE',
      cardTitle: { defaultValue: { language: 'en', value: 'Cedar Gate' } },
      header: { defaultValue: { value: 'Alex Morgan' } },
      logo: { sourceUri: { uri: google.logoUrl } },
      textModulesData: [
        { id: 'f0', header: 'Member', body: 'Alex Morgan' },
        { id: 'f1', header: 'Number', body: '42' },
        { id: 'description', header: 'Description', body: 'Member admission' },
      ],
      barcode: { type: 'QR_CODE', renderEncoding: 'UTF_8', value: 'SCAN-42' },
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      'secret-auth-token',
      'private-serial',
      'pass.private',
      'team.private',
      '/apple/private',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('supports explicitly approved absence of a barcode', () => {
    const { barcodes: _barcodes, ...without } = pass;
    expect(
      renderGoogleProjection({ ...google, barcode: 'none' }, without)?.objectProjection,
    ).not.toHaveProperty('barcode');
    expect(renderGoogleProjection(google, without)).toBeNull();
  });

  it('preserves Google QR alternate text', () => {
    const value = { ...pass, barcodes: [{ ...pass.barcodes[0], altText: 'Member code' }] };
    expect(renderGoogleProjection(google, value)?.objectProjection.barcode).toMatchObject({
      alternateText: 'Member code',
    });
  });

  it('preserves UTF-8 QR payload bytes without treating data as presentation markup', () => {
    const message = '{"member":"Zoë","note":"<b>data</b>"}\nline two';
    const value = { ...pass, barcodes: [{ ...pass.barcodes[0], message }] };
    expect(renderGoogleProjection(google, value)?.objectProjection.barcode).toMatchObject({
      value: message,
    });
  });

  it.each([
    ['NFC', { ...pass, nfc: { message: 'secret' } }],
    ['featured actions', { ...pass, featuredActions: [] }],
    ['second style', { ...pass, storeCard: {} }],
    [
      'unknown field semantics',
      {
        ...pass,
        generic: {
          primaryFields: [
            { key: 'name', value: 'Alex', label: 'Member', changeMessage: '%@ changed' },
            { key: 'member.number', value: 42, label: 'Number' },
          ],
        },
      },
    ],
    [
      'extra field',
      {
        ...pass,
        generic: {
          ...pass.generic,
          backFields: [{ key: 'unapproved', value: 'value', label: 'Extra' }],
        },
      },
    ],
    ['missing field', { ...pass, generic: { primaryFields: pass.generic.primaryFields } }],
    [
      'duplicated field',
      { ...pass, generic: { ...pass.generic, backFields: pass.generic.primaryFields } },
    ],
    [
      'unsupported barcode',
      { ...pass, barcodes: [{ ...pass.barcodes[0], format: 'PKBarcodeFormatPDF417' }] },
    ],
    [
      'non-UTF8 barcode',
      { ...pass, barcodes: [{ ...pass.barcodes[0], messageEncoding: 'iso-8859-1' }] },
    ],
    ['two barcodes', { ...pass, barcodes: [...pass.barcodes, ...pass.barcodes] }],
    ['markup', { ...pass, description: '<b>Unreviewed</b>' }],
    ['a trailing carriage return', { ...pass, organizationName: 'Ada\r' }],
    ['a leading tab', { ...pass, organizationName: '\tAda' }],
    ['a newline in a title', { ...pass, description: 'Ada\nLovelace' }],
    [
      'a trailing carriage return in a field',
      {
        ...pass,
        generic: {
          ...pass.generic,
          primaryFields: [{ key: 'name', value: 'Ada\r', label: 'Member' }],
        },
      },
    ],
    ['a line separator', { ...pass, organizationName: 'Ada\u2028Label: forged' }],
    ['a paragraph separator', { ...pass, description: 'Ada\u2029Lovelace' }],
    ['a right-to-left override', { ...pass, organizationName: 'Ada\u202eLovelace' }],
    ['a bidirectional isolate', { ...pass, description: 'Ada\u2066Lovelace\u2069' }],
    ['a C1 control', { ...pass, description: 'Ada\u0085' }],
    [
      'empty value',
      {
        ...pass,
        generic: { ...pass.generic, primaryFields: [{ key: 'name', value: '', label: 'Member' }] },
      },
    ],
  ])('rejects %s in the current materialization', (_name, value) => {
    expect(renderGoogleProjection(google, value)).toBeNull();
  });

  it('rejects duplicate mappings, unapproved titles and oversized provider data', () => {
    expect(renderGoogleProjection({ ...google, fields: ['name', 'name'] }, pass)).toBeNull();
    expect(renderGoogleProjection({ ...google, titleField: 'other' }, pass)).toBeNull();
  });
});
