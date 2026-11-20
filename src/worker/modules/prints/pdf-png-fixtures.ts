import { zlibSync } from 'fflate';
import { crc32 } from '../templates/package/hash.ts';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * A PNG with valid chunks and CRCs. `raw` is the filtered scanline data (default: opaque grey
 * gradient); a different size from the header's makes a bomb or a truncated file. `extra` chunks
 * go before IDAT (an `acTL` makes it animated).
 */
export function makePng(options: {
  width: number;
  height: number;
  /** 6 is RGBA, 2 RGB; interlace flag 1 marks Adam7. */
  type?: 2 | 6;
  interlace?: 0 | 1;
  raw?: Uint8Array;
  extra?: [string, Uint8Array][];
}): Uint8Array {
  const { width, height, type = 6, interlace = 0 } = options;
  const channels = type === 6 ? 4 : 3;
  const raw =
    options.raw ??
    (() => {
      const stride = width * channels + 1;
      const data = new Uint8Array(stride * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width * channels; x++) data[y * stride + 1 + x] = (x + y) & 255;
      return data;
    })();
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, type, 0, 0, interlace], 8);
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk('IHDR', header),
    ...(options.extra ?? []).map(([t, d]) => chunk(t, d)),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
