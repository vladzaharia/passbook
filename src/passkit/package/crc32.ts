// Slice-by-8 CRC-32 (IEEE). Stored per asset at upload so packaging rarely computes it.
const TABLES: Int32Array[] = (() => {
  const tables = Array.from({ length: 8 }, () => new Int32Array(256));
  const t0 = tables[0] as Int32Array;
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t0[n] as number;
    for (let k = 1; k < 8; k++) {
      c = (t0[c & 255] as number) ^ (c >>> 8);
      (tables[k] as Int32Array)[n] = c;
    }
  }
  return tables;
})();

/** Running CRC-32. Start with `0`, feed chunks, each call returns the CRC so far. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = TABLES as [
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
    Int32Array,
  ];
  let c = ~previous;
  let i = 0;
  const end8 = bytes.length - 7;
  for (; i < end8; i += 8) {
    const lo =
      c ^
      ((bytes[i] as number) |
        ((bytes[i + 1] as number) << 8) |
        ((bytes[i + 2] as number) << 16) |
        ((bytes[i + 3] as number) << 24));
    c =
      (t7[lo & 255] as number) ^
      (t6[(lo >>> 8) & 255] as number) ^
      (t5[(lo >>> 16) & 255] as number) ^
      (t4[lo >>> 24] as number) ^
      (t3[bytes[i + 4] as number] as number) ^
      (t2[bytes[i + 5] as number] as number) ^
      (t1[bytes[i + 6] as number] as number) ^
      (t0[bytes[i + 7] as number] as number);
  }
  for (; i < bytes.length; i++) c = (t0[(c ^ (bytes[i] as number)) & 255] as number) ^ (c >>> 8);
  return ~c >>> 0;
}
