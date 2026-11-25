import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PAPER_SPECS, type PaperSize } from '../../../passkit/template/paper.ts';
import { codeShapes, pdfText, readPdf } from './pdf-read.ts';
import { renderPdf } from './pdf-render.ts';
import { SAMPLE_CODE, sheet } from './pdf-render-fixtures.ts';

const PT = 72 / 25.4;
const render = (...sheets: Parameters<typeof renderPdf>[0]) =>
  renderPdf(sheets, { assets: env.ASSETS });
const NEW: [PaperSize, number][] = [
  ['cr80p', 2],
  ['stub', 1],
  ['atb', 1],
  ['a6', 1],
  ['dl', 1],
  ['half-letter', 1],
];

describe('new sizes render', () => {
  it.each(NEW)(
    '%s: %i page(s) at its size, with the code as text and a drawn symbol',
    async (size, pages) => {
      for (const kind of ['membership', 'admission'] as const) {
        const bytes = await render(sheet(kind, size));
        const read = await readPdf(bytes);
        expect(read).toHaveLength(pages);
        for (const p of read) {
          expect(p.size.w).toBeCloseTo(PAPER_SPECS[size].widthMm * PT, 0);
          expect(p.size.h).toBeCloseTo(PAPER_SPECS[size].heightMm * PT, 0);
        }
        expect((await pdfText(bytes)).replace(/\s/g, '')).toContain(SAMPLE_CODE);
        const shapes = codeShapes(read[0] as (typeof read)[number]);
        expect(shapes?.polygons.length ?? 0).toBeGreaterThan(10);
      }
    },
  );

  it.each(NEW)('%s: mono and test mode render', async (size) => {
    const mono = await render(
      sheet('admission', size, { paper: { ink: 'mono' }, content: { ink: 'mono' } }),
    );
    expect((await readPdf(mono)).length).toBeGreaterThan(0);
    const test = await render(sheet('admission', size, { mode: 'test' }));
    expect((await pdfText(test)).replace(/\s/g, '')).toContain(SAMPLE_CODE);
  });

  it.each([
    ['permit', 'half-letter'],
    ['coupon', 'half-letter'],
    ['permit', 'stub'],
    ['coupon', 'atb'],
  ] as const)('%s on %s', async (kind, size) => {
    const text = await pdfText(await render(sheet(kind, size)));
    expect(text.replace(/\s/g, '')).toContain(SAMPLE_CODE);
  });

  it.each(['atb', 'dl'] as const)('%s draws Code 128 at least 83 mm wide', async (size) => {
    const read = await readPdf(
      await render(sheet('admission', size, { paper: { barcode: 'code128' } })),
    );
    const box = codeShapes(read[0] as (typeof read)[number])?.box;
    expect((box?.w ?? 0) / PT).toBeGreaterThan(83);
  });

  it.each(['cr80', 'cr80p'] as const)(
    '%s on a home sheet: one A4 or Letter page with both faces',
    async (size) => {
      for (const home of ['a4', 'letter'] as const) {
        const read = await readPdf(
          await render(sheet('membership', size, { paper: { sheet: home } })),
        );
        expect(read).toHaveLength(1);
        expect(read[0]?.size.w).toBeCloseTo(PAPER_SPECS[home].widthMm * PT, 0);
        expect(read[0]?.size.h).toBeCloseTo(PAPER_SPECS[home].heightMm * PT, 0);
        // The front's code is drawn; the back carries the typed code.
        expect(codeShapes(read[0] as (typeof read)[number])).toBeDefined();
        expect(
          (
            await pdfText(await render(sheet('membership', size, { paper: { sheet: home } })))
          ).replace(/\s/g, ''),
        ).toContain(SAMPLE_CODE);
      }
    },
  );
});
