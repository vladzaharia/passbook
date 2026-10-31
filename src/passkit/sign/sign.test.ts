import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packagePass, packagePassBytes, packagePasses } from '../package/zip.ts';
import { createFixtureIdentity, FIXTURE_IDENTITY } from '../testing/fixture-identity.ts';
import type { SigningMaterial } from '../types.ts';
import { certificateInfo, signManifest, signPass } from './index.ts';

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const pass = {
  formatVersion: 1,
  passTypeIdentifier: FIXTURE_IDENTITY.passTypeIdentifier,
  teamIdentifier: FIXTURE_IDENTITY.teamIdentifier,
  serialNumber: 's1',
  organizationName: 'Org',
  description: 'Pass',
  generic: { primaryFields: [{ key: 'a', value: 'b' }] },
};

let material: SigningMaterial;
let dir: string;

beforeAll(async () => {
  material = await createFixtureIdentity();
  dir = mkdtempSync(join(tmpdir(), 'wallet-sign-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const opensslVerify = (signature: Uint8Array, content: Uint8Array) => {
  writeFileSync(join(dir, 'signature'), signature);
  writeFileSync(join(dir, 'manifest.json'), content);
  execFileSync(
    'openssl',
    [
      'cms',
      '-verify',
      '-binary',
      '-inform',
      'DER',
      '-in',
      join(dir, 'signature'),
      '-content',
      join(dir, 'manifest.json'),
      '-noverify',
      '-out',
      '/dev/null',
    ],
    { stdio: 'pipe' },
  );
};

describe('signPass', () => {
  it('produces a manifest whose digests match and a CMS signature OpenSSL verifies', async () => {
    const signed = await signPass(
      pass,
      { 'icon.png': PNG, 'en.lproj/pass.strings': new TextEncoder().encode('"a" = "b";') },
      material,
    );
    expect(Object.keys(signed.files).sort()).toEqual([
      'en.lproj/pass.strings',
      'icon.png',
      'manifest.json',
      'pass.json',
      'signature',
    ]);
    for (const [name, sha1] of Object.entries(signed.manifest)) {
      expect(
        createHash('sha1')
          .update(signed.files[name] as Uint8Array)
          .digest('hex'),
        name,
      ).toBe(sha1);
    }
    expect(Object.keys(signed.manifest)).not.toContain('signature');
    const manifest = signed.files['manifest.json'] as Uint8Array;
    opensslVerify(signed.files.signature as Uint8Array, manifest);
    expect(() =>
      opensslVerify(signed.files.signature as Uint8Array, new TextEncoder().encode('tampered')),
    ).toThrow();
  });

  it('uses precomputed asset hashes when given', async () => {
    const signed = await signPass(pass, { 'icon.png': PNG }, material, {
      precomputedSha1: { 'icon.png': 'a'.repeat(40) },
    });
    expect(signed.manifest['icon.png']).toBe('a'.repeat(40));
  });

  it('refuses a pass whose identity does not match the certificate', async () => {
    await expect(
      signPass({ ...pass, teamIdentifier: 'OTHERTEAM1' }, { 'icon.png': PNG }, material),
    ).rejects.toThrow(/identity/);
    await expect(
      signPass({ ...pass, passTypeIdentifier: 'pass.other' }, { 'icon.png': PNG }, material),
    ).rejects.toThrow(/identity/);
  });

  it('refuses unsafe asset names', async () => {
    for (const name of ['../icon.png', 'a/b.png', 'icon.exe', 'pass.json']) {
      await expect(signPass(pass, { [name]: PNG }, material)).rejects.toThrow(/Unsafe asset/);
    }
  });

  it('refuses an expired certificate and a mismatched key', async () => {
    await expect(
      signPass(pass, { 'icon.png': PNG }, material, { now: new Date(Date.now() + 10 * 86400_000) }),
    ).rejects.toThrow(/valid/);
    const other = await createFixtureIdentity();
    await expect(
      signPass(pass, { 'icon.png': PNG }, { ...material, privateKey: other.privateKey }),
    ).rejects.toThrow(/key does not match/);
  });

  it('refuses a certificate not issued by the intermediate', async () => {
    const other = await createFixtureIdentity();
    await expect(
      signManifest(new Uint8Array([1]), { ...material, intermediate: other.intermediate }),
    ).rejects.toThrow(/intermediate|chain/i);
  });
});

describe('certificateInfo', () => {
  it('reads pass type, team and validity', async () => {
    const info = await certificateInfo(material.certificate);
    expect(info.passTypeIdentifier).toBe(FIXTURE_IDENTITY.passTypeIdentifier);
    expect(info.teamIdentifier).toBe(FIXTURE_IDENTITY.teamIdentifier);
    expect(info.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('packaging', () => {
  it('streams a zip equal in content to the byte packager and deterministic', async () => {
    const signed = await signPass(pass, { 'icon.png': PNG }, material);
    const streamed = new Uint8Array(await new Response(packagePass(signed)).arrayBuffer());
    const files = unzipSync(streamed);
    expect(Object.keys(files).sort()).toEqual(Object.keys(signed.files).sort());
    expect(files['icon.png']).toEqual(PNG);
    const again = new Uint8Array(await new Response(packagePass(signed)).arrayBuffer());
    expect(again).toEqual(streamed);
    expect(unzipSync(packagePassBytes(signed))['pass.json']).toEqual(signed.files['pass.json']);
  });

  it('bundles passes into a .pkpasses archive of .pkpass files', async () => {
    const signed = await signPass(pass, { 'icon.png': PNG }, material);
    const bundle = unzipSync(
      new Uint8Array(
        await new Response(
          packagePasses([
            { name: 'a', bytes: packagePassBytes(signed) },
            { name: 'b.pkpass', bytes: async () => packagePassBytes(signed) },
          ]),
        ).arrayBuffer(),
      ),
    );
    expect(Object.keys(bundle)).toEqual(['a.pkpass', 'b.pkpass']);
    expect(Object.keys(unzipSync(bundle['a.pkpass'] as Uint8Array))).toContain('signature');
  });
});
