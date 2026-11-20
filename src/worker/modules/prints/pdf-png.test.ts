import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readPng } from './pdf-png.ts';
import { makePng } from './pdf-png-fixtures.ts';
import { pdfText } from './pdf-read.ts';
import { MAX_DISTINCT_IMAGES, renderPdf } from './pdf-render.ts';
import { sheet } from './pdf-render-fixtures.ts';

const ART_FIT = { wMm: 97, hMm: 44, mode: 'cover' } as const;
const text = new TextDecoder('latin1');
const widths = (pdf: Uint8Array) =>
  [...text.decode(pdf).matchAll(/\/Width (\d+)/g)].map((m) => Number(m[1]));

const render = async (images: NonNullable<Parameters<typeof sheet>[2]>['images']) => {
  const refused: [string, string][] = [];
  const bytes = await renderPdf([sheet('admission', 'a4', { images })], {
    assets: env.ASSETS,
    onImageError: (id, reason) => refused.push([id, reason]),
  });
  return { bytes, refused };
};

describe('PNG guard', () => {
  it('refuses a small file that inflates far past its header, and draws without it', async () => {
    // 1074 x 1344 RGBA is 5.8 MB; this IDAT inflates to 40 MB from about 40 KB.
    const bomb = makePng({ width: 1074, height: 1344, raw: new Uint8Array(40_000_000) });
    expect(bomb.length).toBeLessThan(200_000);
    expect(readPng(bomb, ART_FIT)).toBeNull();
    const tiny = makePng({ width: 8, height: 8, raw: new Uint8Array(40_000_000) });
    expect(readPng(tiny, ART_FIT)).toBeNull();
    const { bytes, refused } = await render({
      logo: { id: 'bomb-logo', bytes: tiny },
      art: { id: 'bomb-art', bytes: bomb },
    });
    expect(refused).toEqual([
      ['bomb-logo', 'invalid'],
      ['bomb-art', 'invalid'],
    ]);
    expect(await pdfText(bytes)).toContain('Harbour Lights: Night Two');
  });

  it('refuses an animated PNG, an interlaced one, and one larger than a slot can be', () => {
    const animated = makePng({
      width: 4,
      height: 4,
      extra: [['acTL', new Uint8Array(8).fill(1)]],
    });
    expect(readPng(animated, ART_FIT)).toBeNull();
    expect(readPng(makePng({ width: 4, height: 4, interlace: 1 }), ART_FIT)).toBeNull();
    const huge = makePng({ width: 2000, height: 2000, raw: new Uint8Array(10) });
    expect(readPng(huge, ART_FIT)).toBeNull();
    expect(readPng(new Uint8Array([1, 2, 3]), ART_FIT)).toBeNull();
    expect(readPng(makePng({ width: 4, height: 4 }), ART_FIT)).not.toBeNull();
  });

  it('keeps a slot-size image at its size and shrinks one past 300 dpi', async () => {
    const slot = await render({
      art: { id: 'slot', bytes: makePng({ width: 1074, height: 1344 }) },
    });
    expect(slot.refused).toEqual([]);
    expect(Math.max(...widths(slot.bytes))).toBe(1074);
    // 1600 x 1200 over a 97 x 44 mm box needs 1146 px across at 300 dpi.
    const big = await render({ art: { id: 'big', bytes: makePng({ width: 1600, height: 1200 }) } });
    expect(big.refused).toEqual([]);
    const across = Math.max(...widths(big.bytes));
    expect(across).toBeGreaterThan(1100);
    expect(across).toBeLessThan(1200);
    expect(big.bytes.length).toBeLessThan(slot.bytes.length * 3);
  });

  it('embeds no more than the cap of distinct images and reports the rest', async () => {
    const refused: [string, string][] = [];
    const sheets = Array.from({ length: MAX_DISTINCT_IMAGES + 2 }, (_, i) =>
      sheet('admission', 'a4', {
        images: { logo: { id: `logo-${i}`, bytes: makePng({ width: 4, height: 4 }) } },
      }),
    );
    const bytes = await renderPdf(sheets, {
      assets: env.ASSETS,
      onImageError: (id, reason) => refused.push([id, reason]),
    });
    expect(refused).toEqual([
      [`logo-${MAX_DISTINCT_IMAGES}`, 'limit'],
      [`logo-${MAX_DISTINCT_IMAGES + 1}`, 'limit'],
    ]);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
