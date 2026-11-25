const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * The CRC32 NTAG 424 DNA checks in ChangeKey: the common reflected CRC-32 (poly 0xEDB88320, init
 * 0xFFFFFFFF) without the final inversion (the "JAM" form), sent least significant byte first.
 */
export function crc32Nk(data: Uint8Array): Uint8Array {
  let c = 0xffffffff;
  for (const b of data) c = (TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return new Uint8Array([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff]);
}
