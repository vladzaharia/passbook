import { describe, expect, it } from 'vitest';
import type { GoogleProjection, SamsungProjection } from './projection-contract.ts';
import {
  canRenderSamsungProjection,
  renderGoogleProjection,
  renderSamsungProjection,
} from './render-projection.ts';

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
const samsung: SamsungProjection = {
  ...google,
  provider: 'samsung',
  cardType: 'loyalty',
  cardSubType: 'others',
  countryCode: 'GB',
  appLinkLogo: 'https://example.test/app.png',
  appLinkName: 'Open account',
  appLinkData: 'https://example.test/account',
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
const ref = 'A'.repeat(32);
const samsungRender = (value: unknown, mapping = samsung) =>
  renderSamsungProjection(mapping, value, ref, 1000, 2000);

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

  it('renders Samsung loyalty attributes in the documented flat and escaped format', () => {
    const item = samsungRender(pass)?.card.data[0];
    expect(item).toMatchObject({
      refId: ref,
      state: 'ACTIVE',
      createdAt: 1000,
      updatedAt: 2000,
      attributes: {
        title: 'Alex Morgan',
        providerName: 'Cedar Gate',
        logoImage: samsung.logoUrl,
        appLinkLogo: samsung.appLinkLogo,
        appLinkName: samsung.appLinkName,
        appLinkData: samsung.appLinkData,
        'barcode.value': 'SCAN-42',
        'barcode.serialType': 'QRCODE',
        'barcode.ptFormat': 'QRCODE',
        'barcode.ptSubFormat': 'QR_CODE',
      },
    });
    expect(JSON.parse(item?.attributes.extendedFields as string)).toEqual([
      { label: 'Member', value: 'Alex Morgan', order: 1 },
      { label: 'Number', value: '42', order: 2 },
      { label: 'Description', value: 'Member admission', order: 3 },
    ]);
    expect(JSON.stringify(item)).not.toContain('secret-auth-token');
  });

  it('supports explicitly approved absence of a barcode', () => {
    const { barcodes: _barcodes, ...without } = pass;
    expect(
      renderGoogleProjection({ ...google, barcode: 'none' }, without)?.objectProjection,
    ).not.toHaveProperty('barcode');
    expect(
      samsungRender(without, { ...samsung, barcode: 'none' })?.card.data[0]?.attributes,
    ).not.toHaveProperty('barcode.value');
    expect(renderGoogleProjection(google, without)).toBeNull();
    expect(samsungRender(without)).toBeNull();
  });

  it('preserves Google QR alternate text but rejects it for Samsung', () => {
    const value = { ...pass, barcodes: [{ ...pass.barcodes[0], altText: 'Member code' }] };
    expect(renderGoogleProjection(google, value)?.objectProjection.barcode).toMatchObject({
      alternateText: 'Member code',
    });
    expect(samsungRender(value)).toBeNull();
  });

  it('preserves UTF-8 QR payload bytes without treating data as presentation markup', () => {
    const message = '{"member":"Zoë","note":"<b>data</b>"}\nline two';
    const value = { ...pass, barcodes: [{ ...pass.barcodes[0], message }] };
    expect(renderGoogleProjection(google, value)?.objectProjection.barcode).toMatchObject({
      value: message,
    });
    expect(samsungRender(value)?.card.data[0]?.attributes['barcode.value']).toBe(message);
    expect(
      samsungRender({ ...pass, barcodes: [{ ...pass.barcodes[0], message: '\ud800' }] }),
    ).toBeNull();
    expect(
      samsungRender({ ...pass, barcodes: [{ ...pass.barcodes[0], message: 'é'.repeat(2049) }] }),
    ).toBeNull();
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
    [
      'empty value',
      {
        ...pass,
        generic: { ...pass.generic, primaryFields: [{ key: 'name', value: '', label: 'Member' }] },
      },
    ],
  ])('rejects %s in the current materialization', (_name, value) => {
    expect(renderGoogleProjection(google, value)).toBeNull();
    expect(samsungRender(value)).toBeNull();
  });

  it('rejects duplicate mappings, unapproved titles and oversized provider data', () => {
    expect(renderGoogleProjection({ ...google, fields: ['name', 'name'] }, pass)).toBeNull();
    expect(renderGoogleProjection({ ...google, titleField: 'other' }, pass)).toBeNull();
    expect(samsungRender({ ...pass, organizationName: 'A'.repeat(33) })).toBeNull();
    expect(samsungRender({ ...pass, description: 'A'.repeat(501) })).toBeNull();
    const tooLong = {
      ...pass,
      description: 'A'.repeat(500),
      generic: {
        ...pass.generic,
        secondaryFields: [{ key: 'member.number', value: 'B'.repeat(500), label: 'Number' }],
      },
    };
    expect(samsungRender(tooLong)).toBeNull();
  });

  it('checks Samsung renderability without allocating or persisting a reference', () => {
    expect(canRenderSamsungProjection(samsung, pass)).toBe(true);
    expect(canRenderSamsungProjection(samsung, { ...pass, nfc: { message: 'unapproved' } })).toBe(
      false,
    );
    expect(canRenderSamsungProjection(samsung, { ...pass, description: 'A'.repeat(501) })).toBe(
      false,
    );
    const unlabeled = {
      ...pass,
      generic: { ...pass.generic, primaryFields: [{ key: 'name', value: 'Alex' }] },
    };
    expect(canRenderSamsungProjection(samsung, unlabeled)).toBe(false);
  });

  it('requires a valid Samsung reference, time ordering and labels', () => {
    expect(renderSamsungProjection(samsung, pass, 'short', 1000, 2000)).toBeNull();
    expect(renderSamsungProjection(samsung, pass, ref, 2000, 1000)).toBeNull();
    const noLabel = {
      ...pass,
      generic: { ...pass.generic, primaryFields: [{ key: 'name', value: 'Alex' }] },
    };
    expect(renderGoogleProjection(google, noLabel)).not.toBeNull();
    expect(samsungRender(noLabel)).toBeNull();
  });
});
