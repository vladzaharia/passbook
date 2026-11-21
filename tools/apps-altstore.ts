// Builds the AltStore / SideStore source (format v2) from the ios-v* GitHub releases.
//   node tools/apps-altstore.ts --releases releases.json --assets dir --pages-url URL --out source.json
// releases.json is `gh api repos/OWNER/REPO/releases --paginate | jq -s add`; dir holds <tag>/release.json per release.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const SOURCE_ID = 'mobile.passbook.source';
export const BUNDLE_ID = 'mobile.passbook.scanner';
const TINT = '2dd4bf';

type ReleaseAsset = { name: string; size: number; browser_download_url: string };
export type Release = {
  tag_name: string;
  published_at: string | null;
  body: string | null;
  assets: ReleaseAsset[];
};
export type BuildInfo = {
  version: string;
  build: string;
  ipa: string;
  sha256: string;
  minimumIos: string;
};
export type Permissions = { entitlements: string[]; privacy: Record<string, string> };

const decode = (text: string) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/** Entitlement keys and usage descriptions, read from the app's own plists. */
export function readPermissions(infoPlist: string, entitlements: string): Permissions {
  const privacy: Record<string, string> = {};
  for (const m of infoPlist.matchAll(
    /<key>(\w+UsageDescription)<\/key>\s*<string>([^<]*)<\/string>/g,
  )) {
    privacy[m[1] as string] = decode(m[2] as string);
  }
  const keys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1] as string);
  return { entitlements: keys, privacy };
}

export type SourceOptions = {
  pagesUrl: string;
  releases: Release[];
  builds: Record<string, BuildInfo>;
  permissions: Permissions;
};

export function buildSource({ pagesUrl, releases, builds, permissions }: SourceOptions) {
  const versions = releases
    .filter((r) => r.tag_name.startsWith('ios-v') && builds[r.tag_name])
    .flatMap((r) => {
      const info = builds[r.tag_name] as BuildInfo;
      const asset = r.assets.find((a) => a.name === info.ipa);
      if (!asset || !r.published_at) return [];
      return [
        {
          version: info.version,
          buildVersion: info.build,
          date: r.published_at.slice(0, 10),
          localizedDescription:
            (r.body ?? '').split('\n')[0]?.trim() || `PassBook Scanner ${info.version}`,
          downloadURL: asset.browser_download_url,
          size: asset.size,
          sha256: info.sha256,
          minOSVersion: info.minimumIos,
        },
      ];
    })
    .sort(
      (a, b) => b.date.localeCompare(a.date) || Number(b.buildVersion) - Number(a.buildVersion),
    );
  return {
    name: 'PassBook',
    identifier: SOURCE_ID,
    subtitle: 'Scanner apps for PassBook',
    description: 'PassBook Scanner, built from github.com/vladzaharia/passbook.',
    iconURL: `${pagesUrl}/altstore/icon.png`,
    website: `${pagesUrl}/`,
    tintColor: TINT,
    apps: versions.length
      ? [
          {
            name: 'PassBook Scanner',
            bundleIdentifier: BUNDLE_ID,
            developerName: 'PassBook',
            subtitle: 'Scan passes at the door',
            localizedDescription: 'Scan pass barcodes and NFC tags for PassBook events.',
            iconURL: `${pagesUrl}/altstore/icon.png`,
            tintColor: TINT,
            appPermissions: permissions,
            versions,
          },
        ]
      : [],
    news: [],
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isHttps = (v: unknown) => isStr(v) && /^https:\/\/[^\s]+$/.test(v);

/** Checks the source against the documented AltStore v2 shape; returns one message per problem. */
export function validateSource(src: unknown): string[] {
  const errors: string[] = [];
  const s = src as Record<string, unknown>;
  if (!s || typeof s !== 'object') return ['source is not an object'];
  for (const k of ['name', 'identifier']) if (!isStr(s[k])) errors.push(`${k} is required`);
  for (const k of ['iconURL', 'website'])
    if (s[k] !== undefined && !isHttps(s[k])) errors.push(`${k} must be https`);
  if (s.tintColor !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(String(s.tintColor)))
    errors.push('tintColor must be hex');
  if (!Array.isArray(s.apps)) return [...errors, 'apps must be an array'];
  const bundles = new Set<string>();
  s.apps.forEach((raw, i) => {
    const a = raw as Record<string, unknown>;
    const at = `apps[${i}]`;
    for (const k of ['name', 'bundleIdentifier', 'developerName', 'localizedDescription']) {
      if (!isStr(a[k])) errors.push(`${at}.${k} is required`);
    }
    if (!isHttps(a.iconURL)) errors.push(`${at}.iconURL must be https`);
    if (isStr(a.bundleIdentifier)) {
      if (bundles.has(a.bundleIdentifier)) errors.push(`${at}.bundleIdentifier is repeated`);
      bundles.add(a.bundleIdentifier);
    }
    const perms = a.appPermissions as Permissions | undefined;
    if (perms) {
      if (!Array.isArray(perms.entitlements) || !perms.entitlements.every(isStr))
        errors.push(`${at}.appPermissions.entitlements must be strings`);
      if (!perms.privacy || !Object.values(perms.privacy).every(isStr))
        errors.push(`${at}.appPermissions.privacy must map keys to text`);
    }
    if (!Array.isArray(a.versions) || a.versions.length === 0) {
      errors.push(`${at}.versions needs an entry`);
      return;
    }
    a.versions.forEach((rawV, j) => {
      const v = rawV as Record<string, unknown>;
      const vt = `${at}.versions[${j}]`;
      if (!isStr(v.version) || !/^\d+(\.\d+){0,2}/.test(v.version))
        errors.push(`${vt}.version is invalid`);
      if (!isStr(v.buildVersion)) errors.push(`${vt}.buildVersion is required`);
      if (!isStr(v.date) || Number.isNaN(Date.parse(v.date)))
        errors.push(`${vt}.date must be an ISO date`);
      if (!isHttps(v.downloadURL)) errors.push(`${vt}.downloadURL must be https`);
      if (!Number.isInteger(v.size) || (v.size as number) <= 0)
        errors.push(`${vt}.size must be a positive integer`);
      if (!isStr(v.minOSVersion)) errors.push(`${vt}.minOSVersion is required`);
      if (v.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(v.sha256)))
        errors.push(`${vt}.sha256 must be 64 hex characters`);
    });
  });
  return errors;
}

function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const value = i < 0 ? undefined : process.argv[i + 1];
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const releases = JSON.parse(readFileSync(arg('releases'), 'utf8')) as Release[];
  const builds: Record<string, BuildInfo> = {};
  for (const r of releases) {
    if (!r.tag_name.startsWith('ios-v')) continue;
    try {
      const info = JSON.parse(
        readFileSync(join(arg('assets'), r.tag_name, 'release.json'), 'utf8'),
      );
      builds[r.tag_name] = { ...info, minimumIos: info.minimumIos ?? '17.0' };
    } catch {
      console.error(`::warning title=Release skipped::${r.tag_name} has no release.json asset`);
    }
  }
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const permissions = readPermissions(
    read('ios/PassBookScanner/Info.plist'),
    read('ios/PassBookScanner/PassBookScanner.entitlements'),
  );
  const source = buildSource({
    pagesUrl: arg('pages-url').replace(/\/$/, ''),
    releases,
    builds,
    permissions,
  });
  const errors = validateSource(source);
  if (errors.length) throw new Error(`Invalid AltStore source:\n${errors.join('\n')}`);
  writeFileSync(arg('out'), `${JSON.stringify(source, null, 2)}\n`);
}

if (process.argv[1] === import.meta.filename) main();
