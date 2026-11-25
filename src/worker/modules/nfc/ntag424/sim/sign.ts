import { fromInt, G, inv, mod, mul, N, type Point } from '../p224.ts';

/** Test-only ECDSA signing with a caller nonce, and a test originality key; never imported by production code. */
export const publicPoint = (priv: bigint): Point => mul(priv, G) as Point;

export function ecdsaSign(priv: bigint, z: bigint, k: bigint): { r: bigint; s: bigint } {
  const r = mod((mul(k, G) as Point)[0], N);
  const s = mod(inv(k, N) * (z + r * priv), N);
  if (r === 0n || s === 0n) throw new RangeError('unusable nonce');
  return { r, s };
}

/** `r || s` as the tag returns it. */
export const encodeSignature = (r: bigint, s: bigint): Uint8Array => {
  const out = new Uint8Array(56);
  out.set(fromInt(r, 28));
  out.set(fromInt(s, 28), 28);
  return out;
};
