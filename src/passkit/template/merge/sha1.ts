/** Synchronous SHA-1 (hex), for merged files whose bytes the engine writes itself. */
export function sha1Hex(data: Uint8Array): string {
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const w = new Uint32Array(80);
  const rol = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4);
    for (let j = 16; j < 80; j++)
      w[j] = rol(
        (w[j - 3] as number) ^ (w[j - 8] as number) ^ (w[j - 14] as number) ^ (w[j - 16] as number),
        1,
      );
    let [a, b, c, d, e] = h as [number, number, number, number, number];
    for (let j = 0; j < 80; j++) {
      const [f, k] =
        j < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : j < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : j < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const tmp = (rol(a, 5) + (f as number) + e + (k as number) + (w[j] as number)) >>> 0;
      [e, d, c, b, a] = [d, c, rol(b, 30) >>> 0, a, tmp];
    }
    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}
