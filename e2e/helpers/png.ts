import { zlibSync } from 'fflate';

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
}

/** A w x h PNG: a rounded ring and two bars in `rgb` on transparent, enough to read as a logo. */
export function logoPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 4));
  const r = h / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - r, y - r);
      const ring = d < r * 0.92 && d > r * 0.55;
      const bar =
        (x > r * 2.3 && x < w * 0.85 && y > h * 0.3 && y < h * 0.48) ||
        (x > r * 2.3 && x < w * 0.6 && y > h * 0.6 && y < h * 0.72);
      if (ring || bar) raw.set([...rgb, 255], y * (1 + w * 4) + 1 + x * 4);
    }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', Buffer.from(zlibSync(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
