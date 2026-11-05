import { describe, expect, it } from 'vitest';
import { rosterHash } from './hash.ts';

describe('rosterHash', () => {
  it('is the first 128 bits (32 hex) of SHA-256 of the code', async () => {
    // sha256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad
    expect(await rosterHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223');
  });

  it('hashes the trimmed UTF-8 string, so a trailing newline changes nothing', async () => {
    expect(await rosterHash('  abc\n')).toBe(await rosterHash('abc'));
  });
});
