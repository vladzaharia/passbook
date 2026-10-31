import { describe, expect, it } from 'vitest';
import { certDetails, checkKeyPem } from './cert.ts';
import {
  FIXTURE_CERT_PEM,
  FIXTURE_KEY_PEM,
  LEGACY_P12,
  MODERN_P12,
  P12_PASSWORD,
} from './p12-fixtures.ts';
import { readPkcs12 } from './pkcs12.ts';

describe('readPkcs12', () => {
  it('extracts the certificate and PKCS#8 key from an AES PKCS#12', async () => {
    const out = await readPkcs12(MODERN_P12, P12_PASSWORD);
    expect(out.certificates).toHaveLength(1);
    expect((await certDetails(out.certificates[0] ?? '')).sha256).toBe(
      (await certDetails(FIXTURE_CERT_PEM)).sha256,
    );
    expect(out.privateKeyPem.replace(/\s/g, '')).toBe(FIXTURE_KEY_PEM.replace(/\s/g, ''));
  });

  it('points legacy 3DES files at npm run credentials', async () => {
    await expect(readPkcs12(LEGACY_P12, P12_PASSWORD)).rejects.toMatchObject({
      code: 'P12_LEGACY',
      message: expect.stringContaining('npm run credentials'),
    });
  });

  it('rejects a wrong password and garbage input', async () => {
    await expect(readPkcs12(MODERN_P12, 'wrong')).rejects.toMatchObject({ code: 'P12_UNREADABLE' });
    await expect(readPkcs12('AAAA', 'pw')).rejects.toMatchObject({ code: 'P12_UNREADABLE' });
    await expect(readPkcs12('not base64 !!', 'pw')).rejects.toMatchObject({
      code: expect.stringMatching(/P12_/),
    });
  });
});

describe('checkKeyPem', () => {
  it('accepts PKCS#8 and explains PKCS#1, encrypted and missing keys', () => {
    expect(checkKeyPem(FIXTURE_KEY_PEM)).toContain('BEGIN PRIVATE KEY');
    expect(() =>
      checkKeyPem('-----BEGIN RSA PRIVATE KEY-----\nAA\n-----END RSA PRIVATE KEY-----'),
    ).toThrow(/PKCS#8/);
    expect(() =>
      checkKeyPem('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAA\n-----END ENCRYPTED PRIVATE KEY-----'),
    ).toThrow(/encrypted/);
    expect(() => checkKeyPem('nothing')).toThrow(/No PKCS#8/);
  });
});
