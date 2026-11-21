import { describe, expect, it } from 'vitest';
import { makePng } from './fixtures.ts';
import { crc32 } from './hash.ts';
import { parsePng } from './png.ts';

/** A one-pixel PNG whose header claims another size, with the header's CRC kept valid. */
function claiming(width: number, height: number): Uint8Array {
  const png = makePng(1, 1);
  const view = new DataView(png.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(png, 12, 29));
  return png;
}

describe('parsePng size limits', () => {
  it('accepts the largest slot size', () => {
    expect(parsePng(claiming(1860, 1860))).toMatchObject({ width: 1860, height: 1860 });
  });

  it('refuses a side over 4096 and an area over 3.5 megapixels', () => {
    for (const [w, h] of [
      [4097, 10],
      [4096, 4096],
      [1900, 1900],
    ])
      expect(parsePng(claiming(w as number, h as number)), `${w}x${h}`).toEqual({
        error: 'PNG dimensions are out of range.',
      });
  });
});
