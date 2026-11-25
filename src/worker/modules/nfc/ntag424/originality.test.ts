import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../sun.ts';
import { verifyOriginality } from './originality.ts';
import { verifyUidSignature } from './p224.ts';
import { Ntag424Sim, SIM_ORIGINALITY_KEY } from './sim/tag.ts';

const h = (hex: string) => hexToBytes(hex.replaceAll(' ', '')) as Uint8Array;

// NXP AN12196 rev 2.0 Table 30: UID 04518DFAA96180, signature r || s, NXP public key (secp224r1).
const UID = '04518DFAA96180';
const SIG =
  'D1940D17CFEDA4BFF80359AB975F9F6514313E8F90C1D3CAAF5941AD744A1CDF9A83F883CAFE0FE95D1939B1B7E47113993324473B785D21';

describe('verifyOriginality: AN12196 Table 30', () => {
  it('accepts the published signature for the published UID', () => {
    expect(verifyOriginality(h(UID), h(SIG))).toBe(true);
  });
  it('refuses another UID, a changed signature and a wrong length', () => {
    expect(verifyOriginality(h('04518DFAA96181'), h(SIG))).toBe(false);
    const bad = h(SIG);
    bad[40] = (bad[40] as number) ^ 1;
    expect(verifyOriginality(h(UID), bad)).toBe(false);
    expect(verifyOriginality(h(UID), h(SIG).slice(1))).toBe(false);
    expect(verifyOriginality(h('04518DFAA961'), h(SIG))).toBe(false);
  });
  it('the simulator signs with its own test key, not NXP', () => {
    const sim = new Ntag424Sim();
    expect(verifyUidSignature(SIM_ORIGINALITY_KEY, sim.tag.uid, sim.signature)).toBe(true);
    expect(verifyOriginality(sim.tag.uid, sim.signature)).toBe(false);
    expect(bytesToHex(sim.tag.uid)).toBe('04518dfaa96180');
  });
  it('verifies in well under a second (BigInt, not constant time: public data only)', () => {
    const t = performance.now();
    verifyOriginality(h(UID), h(SIG));
    expect(performance.now() - t < 1000).toBe(true);
  });
});
