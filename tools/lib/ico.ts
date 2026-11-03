// A Windows icon container with PNG frames (Vista and every browser read them), for favicon.ico.

export interface IcoFrame {
  /** Square edge in pixels, 1–256. */
  size: number;
  png: Uint8Array;
}

/** ICONDIR, one 16-byte entry per frame, then the PNGs in order. */
export function encodeIco(frames: IcoFrame[]): Buffer {
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, png }, i) => {
    if (size < 1 || size > 256) throw new Error(`ICO frames are 1–256 px, not ${size}.`);
    const at = 6 + 16 * i;
    // 256 is written as 0.
    head.writeUInt8(size & 0xff, at);
    head.writeUInt8(size & 0xff, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...frames.map((f) => Buffer.from(f.png))]);
}

/** The frames of an ICO written by encodeIco, for tests. */
export function decodeIco(file: Uint8Array): IcoFrame[] {
  const buf = Buffer.from(file);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('Not an ICO.');
  return Array.from({ length: buf.readUInt16LE(4) }, (_, i) => {
    const at = 6 + 16 * i;
    const size = buf.readUInt8(at) || 256;
    const start = buf.readUInt32LE(at + 12);
    return { size, png: buf.subarray(start, start + buf.readUInt32LE(at + 8)) };
  });
}
