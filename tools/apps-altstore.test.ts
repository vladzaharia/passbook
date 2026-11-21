import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_ID,
  buildSource,
  type Release,
  readPermissions,
  SOURCE_ID,
  validateSource,
} from './apps-altstore.ts';

const root = join(import.meta.dirname, '..');
const permissions = readPermissions(
  readFileSync(join(root, 'ios/PassBookScanner/Info.plist'), 'utf8'),
  readFileSync(join(root, 'ios/PassBookScanner/PassBookScanner.entitlements'), 'utf8'),
);
const release = (version: string, date: string): Release => ({
  tag_name: `ios-v${version}`,
  published_at: `${date}T10:00:00Z`,
  body: `PassBook Scanner ${version}.\n\nSHA-256: x`,
  assets: [
    {
      name: `PassBookScanner-${version}.ipa`,
      size: 4096,
      browser_download_url: `https://github.com/vladzaharia/passbook/releases/download/ios-v${version}/PassBookScanner-${version}.ipa`,
    },
  ],
});
const info = (version: string, build: string) => ({
  version,
  build,
  ipa: `PassBookScanner-${version}.ipa`,
  sha256: 'a'.repeat(64),
  minimumIos: '17.0',
});
const make = () =>
  buildSource({
    pagesUrl: 'https://vladzaharia.github.io/passbook',
    releases: [
      release('1.0.0', '2026-11-01'),
      release('1.1.0', '2026-11-20'),
      { ...release('0.2.3', '2026-10-01'), tag_name: 'android-v0.2.3' },
    ],
    builds: { 'ios-v1.0.0': info('1.0.0', '1001'), 'ios-v1.1.0': info('1.1.0', '1002') },
    permissions,
  });

describe('AltStore source', () => {
  it('reads permissions from the app plists', () => {
    expect(permissions.entitlements).toContain('com.apple.developer.nfc.readersession.formats');
    expect(permissions.privacy.NSCameraUsageDescription).toBe(
      'Scan pass barcodes with the camera.',
    );
    expect(permissions.privacy.NFCReaderUsageDescription).toBeTruthy();
  });

  it('lists ios releases newest first and ignores other tags', () => {
    const source = make();
    expect(source.identifier).toBe(SOURCE_ID);
    expect(source.apps).toHaveLength(1);
    const app = source.apps[0];
    expect(app?.bundleIdentifier).toBe(BUNDLE_ID);
    expect(app?.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
    expect(app?.versions[0]).toMatchObject({
      buildVersion: '1002',
      size: 4096,
      minOSVersion: '17.0',
      date: '2026-11-20',
    });
  });

  it('passes validation and has no apps before the first iOS release', () => {
    expect(validateSource(make())).toEqual([]);
    const empty = buildSource({
      pagesUrl: 'https://x.example',
      releases: [],
      builds: {},
      permissions,
    });
    expect(empty.apps).toEqual([]);
    expect(validateSource(empty)).toEqual([]);
  });

  it('rejects a source that breaks the schema', () => {
    const bad = structuredClone(make());
    const v = bad.apps[0]?.versions[0];
    if (!v) throw new Error('missing version');
    v.downloadURL = 'http://insecure.example/app.ipa';
    v.size = 0;
    expect(validateSource(bad)).toEqual(
      expect.arrayContaining([
        'apps[0].versions[0].downloadURL must be https',
        'apps[0].versions[0].size must be a positive integer',
      ]),
    );
    expect(validateSource({ ...make(), identifier: '' })).toContain('identifier is required');
  });
});
