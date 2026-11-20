import { describe, expect, it } from 'vitest';
import { aesCbcDecryptNoPad, aesCmac } from './aes-cmac.ts';
import { diversifyKey } from './diversify.ts';
import { bytesToHex, hexToBytes } from './sun.ts';

const h = (hex: string) => hexToBytes(hex) as Uint8Array;

describe('aesCmac: RFC 4493 section 4 vectors', () => {
  const key = h('2b7e151628aed2a6abf7158809cf4f3c');
  const msg =
    '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710';
  const cases: [string, number, string][] = [
    ['empty', 0, 'bb1d6929e95937287fa37d129b756746'],
    ['16 bytes', 16, '070a16b46b4d4144f79bdd9dd04a287c'],
    ['40 bytes', 40, 'dfa66747de9ae63030ca32611497c827'],
    ['64 bytes', 64, '51f0bebf7e3b9d92fc49741779363cfe'],
  ];
  for (const [name, len, mac] of cases) {
    it(name, async () => {
      expect(bytesToHex(await aesCmac(key, h(msg).slice(0, len)))).toBe(mac);
    });
  }
});

describe('aesCbcDecryptNoPad', () => {
  it('decrypts the NIST SP 800-38A F.2.2 CBC-AES128 block with a zero IV', async () => {
    // Single block, zero IV: ECB-equivalent. SP 800-38A F.1.2 ECB-AES128 block 1.
    const key = h('2b7e151628aed2a6abf7158809cf4f3c');
    const out = await aesCbcDecryptNoPad(key, h('3ad77bb40d7a3660a89ecaf32466ef97'));
    expect(bytesToHex(out)).toBe('6bc1bee22e409f96e93d7e117393172a');
  });
});

describe('PICCData plaintext layout: AN12196 example', () => {
  it('decrypts to C7 || UID || counter (LSB first) under the zero meta key', async () => {
    const out = await aesCbcDecryptNoPad(new Uint8Array(16), h('EF963FF7828658A599F3041510671E88'));
    expect(bytesToHex(out.slice(0, 11))).toBe('c704de5f1eacc0403d0000');
  });
});

describe('diversifyKey: NXP AN10922 section 2.2.1 AES-128 example', () => {
  it('matches the published key', async () => {
    const master = h('00112233445566778899aabbccddeeff');
    const input = h('04782e21801d80' + '3042f5' + '4e585020416275');
    expect(bytesToHex(await diversifyKey(master, input))).toBe('a8dd63a3b89d54b37ca802473fda9175');
  });
});
