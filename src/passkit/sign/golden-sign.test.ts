import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32 } from '../package/crc32.ts';
import { packagePass, packagePassBytes } from '../package/zip.ts';
import { FIXTURES } from '../schema/fixtures.ts';
import { normalizePass } from '../schema/normalize.ts';
import { HIG_CODES } from '../schema/validate-hig.ts';
import { createFixtureIdentity, FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { SigningMaterial } from '../types.ts';
import { validatePass } from '../validate.ts';
import { signPass } from './index.ts';

let material: SigningMaterial;
let dir: string;
beforeAll(async () => {
  material = await createFixtureIdentity();
  dir = mkdtempSync(join(tmpdir(), 'wallet-golden-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9]);
const identity = { ...FIXTURE_IDENTITY, nfcEnabled: true };

function opensslVerify(signature: Uint8Array, content: Uint8Array): void {
  writeFileSync(join(dir, 'sig'), signature);
  writeFileSync(join(dir, 'content'), content);
  execFileSync(
    'openssl',
    [
      'cms',
      '-verify',
      '-binary',
      '-inform',
      'DER',
      '-in',
      join(dir, 'sig'),
      '-content',
      join(dir, 'content'),
      '-noverify',
      '-out',
      '/dev/null',
    ],
    { stdio: 'pipe' },
  );
}

describe('golden passes sign and package', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', async (_name, f) => {
    const pass = normalizePass({
      ...f.pass,
      passTypeIdentifier: identity.passTypeIdentifier,
      teamIdentifier: identity.teamIdentifier,
    });
    // HIG lint has its own fixtures (rules-hig.test.ts); these check structure and signing.
    expect(
      validatePass(pass, f.assets, identity).issues.filter((i) => !HIG_CODES.has(i.code)),
    ).toEqual([]);

    const assets = Object.fromEntries(f.assets.map((a) => [a.name, PNG]));
    const precomputedSha1 = Object.fromEntries(
      f.assets.map((a) => [a.name, createHash('sha1').update(PNG).digest('hex')]),
    );
    const precomputedCrc32 = Object.fromEntries(f.assets.map((a) => [a.name, crc32(PNG)]));
    const signed = await signPass(pass, assets, material, { precomputedSha1, precomputedCrc32 });

    const zip = new Uint8Array(await new Response(packagePass(signed)).arrayBuffer());
    expect(zip).toEqual(packagePassBytes(signed));
    const files = unzipSync(zip);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Record<
      string,
      string
    >;
    expect(Object.keys(manifest).sort()).toEqual(
      Object.keys(files)
        .filter((n) => n !== 'manifest.json' && n !== 'signature')
        .sort(),
    );
    for (const [name, sha1] of Object.entries(manifest))
      expect(
        createHash('sha1')
          .update(files[name] as Uint8Array)
          .digest('hex'),
        name,
      ).toBe(sha1);
    opensslVerify(files.signature as Uint8Array, files['manifest.json'] as Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(files['pass.json']))).toEqual(pass);
  });
});

describe('signPass inputs', () => {
  const pass = {
    formatVersion: 1,
    passTypeIdentifier: FIXTURE_IDENTITY.passTypeIdentifier,
    teamIdentifier: FIXTURE_IDENTITY.teamIdentifier,
    serialNumber: 's',
    organizationName: 'o',
    description: 'd',
    generic: {},
  };

  it('refuses reserved names and case-insensitive duplicates', async () => {
    for (const name of ['manifest.json', 'pass.json'])
      await expect(signPass(pass, { [name]: PNG }, material)).rejects.toThrow(/Unsafe asset/);
    await expect(signPass(pass, { 'icon.png': PNG, 'Icon.png': PNG }, material)).rejects.toThrow(
      /Duplicate asset/,
    );
  });

  it('refuses a malformed precomputed SHA-1', async () => {
    await expect(
      signPass(pass, { 'icon.png': PNG }, material, { precomputedSha1: { 'icon.png': 'xyz' } }),
    ).rejects.toThrow(/SHA-1/);
  });

  it('passes valid CRCs through and drops values for unknown files', async () => {
    const signed = await signPass(pass, { 'icon.png': PNG }, material, {
      precomputedCrc32: { 'icon.png': 5, 'other.png': 6, 'bad.png': -1 },
    });
    expect(signed.crc32).toEqual({ 'icon.png': 5 });
  });

  it('signs repeatedly with the cached chain check', async () => {
    const a = await signPass(pass, { 'icon.png': PNG }, material);
    const b = await signPass(pass, { 'icon.png': PNG }, material);
    opensslVerify(b.files.signature as Uint8Array, b.files['manifest.json'] as Uint8Array);
    expect(a.manifest).toEqual(b.manifest);
  });
});
