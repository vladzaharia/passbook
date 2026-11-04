import { describe, expect, it } from 'vitest';
import { checkKeyId, readP8 } from './push-key.ts';
import { makeP8, makeRsaPem } from './push-key-fixtures.ts';

const code = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code: string }) => e.code,
  );

describe('readP8', () => {
  it('accepts a PKCS#8 EC P-256 key', async () => {
    const { pem } = await makeP8();
    expect((await readP8(pem)).length).toBeGreaterThan(30);
  });

  it('rejects text that is not a .p8', async () => {
    expect(await code(readP8('hello'))).toBe('PUSH_KEY_FORMAT');
    expect(await code(readP8('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'))).toBe(
      'PUSH_KEY_FORMAT',
    );
    expect(
      await code(readP8('-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----')),
    ).toBe('PUSH_KEY_FORMAT');
  });

  it('rejects invalid base64 and garbage DER', async () => {
    expect(await code(readP8('-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----'))).toBe(
      'PUSH_KEY_FORMAT',
    );
    expect(
      await code(readP8('-----BEGIN PRIVATE KEY-----\nAAAAAAAA\n-----END PRIVATE KEY-----')),
    ).toBe('PUSH_KEY_CURVE');
  });

  it('rejects other curves and RSA keys', async () => {
    expect(await code(readP8((await makeP8('P-384')).pem))).toBe('PUSH_KEY_CURVE');
    expect(await code(readP8(await makeRsaPem()))).toBe('PUSH_KEY_CURVE');
  });
});

describe('checkKeyId', () => {
  it('takes 10 letters and digits and trims', () => {
    expect(checkKeyId(' AB12CD34EF ')).toBe('AB12CD34EF');
  });
  it.each(['', 'SHORT', 'AB12CD34EFG', 'ab12cd34ef', 'AB12CD34E!'])('rejects %j', (value) => {
    expect(() => checkKeyId(value)).toThrow(/10 letters and digits/);
  });
});
