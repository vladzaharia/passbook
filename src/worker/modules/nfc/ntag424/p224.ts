/** secp224r1 (NIST P-224) ECDSA over BigInt. WebCrypto has no P-224, and NXP signs the tag UID with it. Not constant time: verify only public data. */

const P = (1n << 224n) - (1n << 96n) + 1n;
const A = P - 3n;
export const N = 0xffffffffffffffffffffffffffff16a2e0b8f03e13dd29455c5c2a3dn;
export const G: Point = [
  0xb70e0cbd6bb4bf7f321390b94a03c1d356c21122343280d6115c1d21n,
  0xbd376388b5f723fb4c22dfe6cd4375a05a07476444d5819985007e34n,
];

export type Point = readonly [bigint, bigint];

export const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

function pow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
  }
  return result;
}

export const inv = (a: bigint, m: bigint) => pow(a, m - 2n, m);

function add(p: Point | null, q: Point | null): Point | null {
  if (!p) return q;
  if (!q) return p;
  const [x1, y1] = p;
  const [x2, y2] = q;
  if (x1 === x2 && mod(y1 + y2, P) === 0n) return null;
  const l =
    x1 === x2 ? mod((3n * x1 * x1 + A) * inv(2n * y1, P), P) : mod((y2 - y1) * inv(x2 - x1, P), P);
  const x3 = mod(l * l - x1 - x2, P);
  return [x3, mod(l * (x1 - x3) - y1, P)];
}

export function mul(k: bigint, p: Point): Point | null {
  let acc: Point | null = null;
  let addend: Point | null = p;
  for (let e = k; e > 0n; e >>= 1n) {
    if (e & 1n) acc = add(acc, addend);
    addend = add(addend, addend);
  }
  return acc;
}

export const toInt = (b: Uint8Array): bigint => b.reduce((n, v) => (n << 8n) | BigInt(v), 0n);
export const fromInt = (n: bigint, len: number): Uint8Array =>
  Uint8Array.from({ length: len }, (_, i) => Number((n >> BigInt(8 * (len - 1 - i))) & 0xffn));

/** Verifies `(r, s)` over the integer `z` (the message, or its hash cut to 224 bits). */
export function ecdsaVerify(pub: Point, r: bigint, s: bigint, z: bigint): boolean {
  if (r < 1n || r >= N || s < 1n || s >= N) return false;
  const w = inv(s, N);
  const point = add(mul(mod(z * w, N), G), mul(mod(r * w, N), pub));
  return point !== null && mod(point[0], N) === r;
}

/** `r || s` (56 bytes) over a 7-byte UID read as a big-endian integer, as NXP signs it. */
export function verifyUidSignature(key: Point, uid: Uint8Array, signature: Uint8Array): boolean {
  if (uid.length !== 7 || signature.length !== 56) return false;
  return ecdsaVerify(key, toInt(signature.slice(0, 28)), toInt(signature.slice(28)), toInt(uid));
}
