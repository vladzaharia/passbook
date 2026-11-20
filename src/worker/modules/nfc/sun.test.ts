import { describe, expect, it } from 'vitest';
import { aesCmac } from './aes-cmac.ts';
import {
  bytesToHex,
  constantTimeEqual,
  hexToBytes,
  SunError,
  type SunKeyset,
  verifySun,
} from './sun.ts';
import { parseSunUrl } from './sun-url.ts';

const h = (hex: string) => hexToBytes(hex) as Uint8Array;
const ZERO = new Uint8Array(16);
const keyset: SunKeyset = { metaKey: ZERO, fileKey: ZERO, diversified: false };

// NXP AN12196 (NTAG 424 DNA and NTAG 424 DNA TagTamper features and hints), SDM example with
// all-zero keys: PICCData = EF963FF7828658A599F3041510671E88 decrypts to
// C7 04DE5F1EACC040 3D0000 + random (UID 04DE5F1EACC040, SDMReadCtr 61), SDMMAC 94EED9EE65337086.
const P = 'EF963FF7828658A599F3041510671E88';
const M = '94EED9EE65337086';

describe('verifySun: AN12196 encrypted PICCData example', () => {
  it('returns the UID and the LSB-first counter', async () => {
    const res = await verifySun(keyset, P, M);
    expect(res).toEqual({ ok: true, read: { uid: '04de5f1eacc040', counter: 61 } });
  });
  it('accepts lowercase hex', async () => {
    expect((await verifySun(keyset, P.toLowerCase(), M.toLowerCase())).ok).toBe(true);
  });
});

describe('verifySun: refusals', () => {
  const fail = async (ks: SunKeyset, p: string, m: string) => {
    const res = await verifySun(ks, p, m);
    return res.ok ? 'ok' : res.error;
  };
  it('wrong tag byte', async () => {
    // Same plaintext with 0xC7 -> 0xC6, re-encrypted under the zero key.
    const key = await crypto.subtle.importKey('raw', ZERO, { name: 'AES-CBC' }, false, ['encrypt']);
    const plain = new Uint8Array(16);
    plain.set(h('c604de5f1eacc0403d0000'));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, plain),
    ).slice(0, 16);
    expect(await fail(keyset, bytesToHex(ct), M)).toBe('SUN_PICC_INVALID');
  });
  it('truncated MAC', async () => {
    expect(await fail(keyset, P, M.slice(0, 14))).toBe('SUN_MALFORMED');
  });
  it('odd-length hex', async () => {
    expect(await fail(keyset, P.slice(0, 31), M)).toBe('SUN_MALFORMED');
    expect(await fail(keyset, P, M.slice(0, 15))).toBe('SUN_MALFORMED');
  });
  it('non-hex', async () => {
    expect(await fail(keyset, `${P.slice(0, 30)}zz`, M)).toBe('SUN_MALFORMED');
  });
  it('wrong file key', async () => {
    const wrong = { ...keyset, fileKey: h('00000000000000000000000000000001') };
    expect(await fail(wrong, P, M)).toBe('SUN_MAC_INVALID');
  });
  it('wrong meta key', async () => {
    const wrong = { ...keyset, metaKey: h('00000000000000000000000000000001') };
    expect(['SUN_PICC_INVALID', 'SUN_MAC_INVALID']).toContain(await fail(wrong, P, M));
  });
  it('every flipped MAC bit', async () => {
    const mac = h(M);
    for (let bit = 0; bit < 64; bit++) {
      const flipped = mac.slice();
      flipped[bit >> 3] = (flipped[bit >> 3] as number) ^ (1 << (bit & 7));
      expect(await fail(keyset, P, bytesToHex(flipped))).toBe('SUN_MAC_INVALID');
    }
  });
  it('every flipped PICC bit', async () => {
    for (let bit = 0; bit < 128; bit++) {
      const p = h(P);
      p[bit >> 3] = (p[bit >> 3] as number) ^ (1 << (bit & 7));
      expect(await fail(keyset, bytesToHex(p), M)).not.toBe('ok');
    }
  });
  it('truncated and empty input', async () => {
    expect(await fail(keyset, P.slice(0, 30), M)).toBe('SUN_MALFORMED');
    expect(await fail(keyset, '', '')).toBe('SUN_MALFORMED');
    expect(await fail(keyset, `${P}00`, M)).toBe('SUN_MALFORMED');
    expect(await fail(keyset, P, `${M}00`)).toBe('SUN_MALFORMED');
  });
  it('a diversified keyset refuses a MAC made with the plain key', async () => {
    const other = await verifySun(keyset, P, M);
    expect(other.ok).toBe(true);
    expect(await fail({ ...keyset, diversified: true }, P, M)).toBe('SUN_MAC_INVALID');
  });
  it('errors carry no key, UID or MAC', () => {
    const err = new SunError('SUN_MAC_INVALID');
    expect(`${err.message}${err.code}`).not.toMatch(/94eed9ee|04de5f1e/i);
  });
});

describe('verifySun: diversified file key', () => {
  // Self-built (no published vector): the MAC is computed from the spec's steps with the
  // AN10922 key, then the verifier must accept it and refuse the undiversified key.
  it('uses the UID-diversified key', async () => {
    const master = h('00112233445566778899aabbccddeeff');
    const meta = h('0102030405060708090a0b0c0d0e0f10');
    const uid = h('04de5f1eacc040');
    const ctr = h('050000');
    const plain = new Uint8Array(16);
    plain[0] = 0xc7;
    plain.set(uid, 1);
    plain.set(ctr, 8);
    const key = await crypto.subtle.importKey('raw', meta, { name: 'AES-CBC' }, false, ['encrypt']);
    const p = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, plain),
    ).slice(0, 16);
    // AN10922 key for this master and UID, computed independently (not by diversifyKey).
    const kfile = h('f26446b4714c2b7e1756860838240443');
    const sv2 = h(`3cc300010080${bytesToHex(uid)}${bytesToHex(ctr)}`);
    const mac = (await aesCmac(await aesCmac(kfile, sv2), new Uint8Array(0))).filter(
      (_, i) => i % 2,
    );
    const ks = { metaKey: meta, fileKey: master, diversified: true };
    expect(await verifySun(ks, bytesToHex(p), bytesToHex(mac))).toEqual({
      ok: true,
      read: { uid: '04de5f1eacc040', counter: 5 },
    });
    expect(
      (await verifySun({ ...ks, diversified: false }, bytesToHex(p), bytesToHex(mac))).ok,
    ).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  it('compares bytes and lengths', () => {
    expect(constantTimeEqual(h('0102'), h('0102'))).toBe(true);
    expect(constantTimeEqual(h('0102'), h('0103'))).toBe(false);
    expect(constantTimeEqual(h('01'), h('0102'))).toBe(false);
  });
});

describe('parseSunUrl', () => {
  const ok = `https://pass.example/t/door-1?p=${P}&m=${M}`;
  it('parses slug, p and m', () => {
    expect(parseSunUrl(ok)).toEqual({ host: 'pass.example', slug: 'door-1', p: P, m: M });
  });
  it.each([
    ['http scheme', ok.replace('https', 'http')],
    ['wrong path', `https://pass.example/x/door-1?p=${P}&m=${M}`],
    ['nested path', `https://pass.example/t/a/b?p=${P}&m=${M}`],
    ['short p', `https://pass.example/t/door-1?p=${P.slice(2)}&m=${M}`],
    ['short m', `https://pass.example/t/door-1?p=${P}&m=${M.slice(2)}`],
    ['missing m', `https://pass.example/t/door-1?p=${P}`],
    ['not a url', 'door-1'],
  ])('rejects %s', (_, value) => {
    expect(parseSunUrl(value)).toBeNull();
  });
});
