import { describe, expect, it } from 'vitest';
import {
  applyDevicePassOverrides,
  DEVICE_PASS_NOTICE,
  DEVICE_PASS_NOTICE_KEY,
  type DevicePassOverrides,
  devicePassViolations,
} from './device-pass.ts';
import { AIRLINE_URL_KEYS, EVENT_URL_KEYS } from './schema/constants.ts';
import type { PassJson } from './schema/pass-types.ts';

const overrides: DevicePassOverrides = {
  passTypeIdentifier: 'pass.mobile.passbook.devtest',
  teamIdentifier: 'TEAM123456',
  serialNumber: 'dp_abc',
  authenticationToken: 'token-token-token-1',
  webServiceURL: 'https://passbook.mobile/wallet',
  expirationDate: Date.UTC(2026, 5, 2, 12),
};

const source = (): PassJson =>
  ({
    formatVersion: 1,
    passTypeIdentifier: 'pass.im.plrs.wallet',
    teamIdentifier: '48H7CLBV8Y',
    serialNumber: 'real-serial',
    organizationName: "Henry's Gym",
    description: 'Membership',
    voided: true,
    sharingProhibited: false,
    appLaunchURL: 'https://evil.example/app',
    associatedStoreIdentifiers: [1],
    nfc: { message: 'x', encryptionPublicKey: 'k' },
    managementURL: 'https://evil.example/manage',
    transitProviderPhoneNumber: '+15550100',
    barcodes: [{ format: 'PKBarcodeFormatQR', message: 'm', messageEncoding: 'iso-8859-1' }],
    locations: [{ latitude: 1, longitude: 2, relevantText: 'You are near' }],
    beacons: [{ proximityUUID: 'u', relevantText: 'Close' }],
    storeCard: {
      headerFields: [
        { key: 'h', value: 'x', attributedValue: '<a href="https://evil.example">x</a>' },
      ],
      primaryFields: [{ key: 'p', value: 'Alex', changeMessage: 'Now %@' }],
      backFields: [
        { key: 'b', value: 'call 555-0100', dataDetectorTypes: ['PKDataDetectorTypePhoneNumber'] },
      ],
    },
  }) as unknown as PassJson;

describe('device pass overrides', () => {
  it('forces the issuer, sharing, expiry, serial, token and web service, and leaves nothing tappable', () => {
    const before = JSON.stringify(source());
    const pass = applyDevicePassOverrides(source(), overrides) as Record<string, unknown>;
    expect(pass).toMatchObject({
      organizationName: 'PassBook Test',
      sharingProhibited: true,
      passTypeIdentifier: overrides.passTypeIdentifier,
      teamIdentifier: overrides.teamIdentifier,
      serialNumber: 'dp_abc',
      authenticationToken: overrides.authenticationToken,
      webServiceURL: overrides.webServiceURL,
      expirationDate: '2026-06-02T12:00:00.000Z',
    });
    for (const key of [
      'appLaunchURL',
      'associatedStoreIdentifiers',
      'nfc',
      'managementURL',
      'transitProviderPhoneNumber',
      'voided',
    ])
      expect(pass, key).not.toHaveProperty(key);
    // Pure: the source is not changed, and what Wallet needs to scan and find stays.
    expect(JSON.stringify(source())).toBe(before);
    expect(pass.barcodes).toEqual(source().barcodes);
    expect((pass.locations as { latitude: number }[])[0]?.latitude).toBe(1);
    expect(devicePassViolations(pass as unknown as PassJson, overrides)).toEqual([]);
  });

  it('turns off data detectors and links on every field, and puts the fixed notice first on the back', () => {
    const pass = applyDevicePassOverrides(source(), overrides);
    const card = pass.storeCard as Record<string, { key: string; [k: string]: unknown }[]>;
    for (const field of Object.values(card).flat()) {
      expect(field.dataDetectorTypes, field.key).toEqual([]);
      expect(field).not.toHaveProperty('attributedValue');
    }
    expect(card.backFields?.[0]).toMatchObject({
      key: DEVICE_PASS_NOTICE_KEY,
      value: DEVICE_PASS_NOTICE,
    });
    expect(card.backFields).toHaveLength(2);
  });

  it('prefixes change messages and relevant text with "Test · ", once', () => {
    const once = applyDevicePassOverrides(source(), overrides);
    const twice = applyDevicePassOverrides(once, overrides);
    for (const pass of [once, twice]) {
      const primary = (pass.storeCard?.primaryFields ?? []) as { changeMessage: string }[];
      expect(primary[0]?.changeMessage).toBe('Test · Now %@');
      expect(pass.locations?.[0]?.relevantText).toBe('Test · You are near');
      expect(pass.beacons?.[0]?.relevantText).toBe('Test · Close');
    }
  });

  it('reports every guard a pass breaks', () => {
    expect(devicePassViolations(source(), overrides)).toEqual(
      expect.arrayContaining([
        'organizationName',
        'sharingProhibited',
        'expirationDate',
        'serialNumber',
        'webServiceURL',
        'appLaunchURL',
        'nfc',
        'managementURL',
        'backFields',
        'dataDetectorTypes',
        'attributedValue',
      ]),
    );
    const sound = applyDevicePassOverrides(source(), overrides);
    expect(devicePassViolations({ ...sound, organizationName: 'Henry' }, overrides)).toEqual([
      'organizationName',
    ]);
    expect(devicePassViolations({ ...sound, sharingProhibited: false }, overrides)).toEqual([
      'sharingProhibited',
    ]);
    expect(devicePassViolations(sound, { ...overrides, serialNumber: 'real-serial' })).toContain(
      'serialNumber',
    );
  });

  it('strips and reports every link-bearing key the schema knows, top level and per upcoming entry', () => {
    const urls = Object.fromEntries([...EVENT_URL_KEYS, ...AIRLINE_URL_KEYS].map((k) => [k, 'x']));
    const field = {
      key: 'f',
      value: 'v',
      attributedValue: '<a href="https://e.example">x</a>',
      dataDetectorTypes: ['PKDataDetectorTypeLink'],
      semantics: {
        wifiAccess: [{ ssid: 's', password: 'p', captiveTokenAuthURL: 'https://e.example' }],
      },
    };
    const entry = {
      identifier: 'e',
      name: 'n',
      type: 'event',
      URLs: { accessibilityURL: 'https://e.example' },
      auxiliaryStoreIdentifiers: [1],
      ...urls,
      additionalInfoFields: [{ ...field }],
      backFields: [{ ...field }],
    };
    const dirty = {
      ...source(),
      ...urls,
      auxiliaryStoreIdentifiers: [2],
      featuredActions: [{ identifier: 'a', type: 'call', url: 'tel:+15550100' }],
      upcomingPassInformation: [entry],
    } as unknown as PassJson;
    const reported = devicePassViolations(dirty, overrides);
    for (const key of [
      ...EVENT_URL_KEYS,
      ...AIRLINE_URL_KEYS,
      'auxiliaryStoreIdentifiers',
      'featuredActions',
    ])
      expect(reported, key).toContain(key);
    expect(reported).toEqual(
      expect.arrayContaining([
        'upcomingPassInformation.URLs',
        'upcomingPassInformation.auxiliaryStoreIdentifiers',
        'upcomingPassInformation.contactVenueWebsite',
        'captiveTokenAuthURL',
      ]),
    );
    const pass = applyDevicePassOverrides(dirty, overrides) as Record<string, unknown>;
    for (const key of [
      ...EVENT_URL_KEYS,
      ...AIRLINE_URL_KEYS,
      'auxiliaryStoreIdentifiers',
      'featuredActions',
    ])
      expect(pass, key).not.toHaveProperty(key);
    const out = (pass.upcomingPassInformation as Record<string, unknown>[])[0] ?? {};
    for (const key of ['URLs', 'auxiliaryStoreIdentifiers', ...EVENT_URL_KEYS])
      expect(out, key).not.toHaveProperty(key);
    for (const f of [...(out.additionalInfoFields as object[]), ...(out.backFields as object[])]) {
      expect(f).not.toHaveProperty('attributedValue');
      expect(f).toMatchObject({ dataDetectorTypes: [] });
      expect(JSON.stringify(f)).not.toContain('captiveTokenAuthURL');
    }
    expect(devicePassViolations(pass as unknown as PassJson, overrides)).toEqual([]);
  });
});
