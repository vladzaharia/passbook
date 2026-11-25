import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PAPER_SPECS, type PaperSize } from '../../../passkit/template/paper.ts';
import { makePng } from './pdf-png-fixtures.ts';
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

  it.each(['cr80', 'cr80p', 'stub', 'atb', 'a6', 'dl'] as const)(
    '%s on a home sheet: one A4 or Letter page, the code drawn, the typed code as text',
    async (size) => {
      for (const home of ['a4', 'letter'] as const) {
        const bytes = await render(sheet('membership', size, { paper: { sheet: home } }));
        const read = await readPdf(bytes);
        expect(read).toHaveLength(1);
        expect(read[0]?.size.w).toBeCloseTo(PAPER_SPECS[home].widthMm * PT, 0);
        expect(read[0]?.size.h).toBeCloseTo(PAPER_SPECS[home].heightMm * PT, 0);
        expect(codeShapes(read[0] as (typeof read)[number])).toBeDefined();
        expect((await pdfText(bytes)).replace(/\s/g, '')).toContain(SAMPLE_CODE);
      }
    },
  );

  it.each(['cr80', 'cr80p'] as const)(
    '%s on a sheet folds: the fold line is dashed, the landscape back is turned',
    async (size) => {
      const read = await readPdf(
        await render(sheet('membership', size, { paper: { sheet: 'a4' } })),
      );
      const content = read[0]?.content ?? '';
      // A landscape card's back is turned; a portrait card's turns like a page and stays upright.
      if (size === 'cr80') expect(content).toMatch(/-1 0 0 -1 [\d.]+ [\d.]+ cm/);
      else expect(content).not.toMatch(/-1 0 0 -1 [\d.]+ [\d.]+ cm/);
      expect(content).toMatch(/\[[\d. ]+\] 0 d/);
    },
  );

  it('a mono card on a sheet has no colour operator', async () => {
    const read = await readPdf(
      await render(
        sheet('membership', 'cr80', {
          paper: { sheet: 'a4', ink: 'mono' },
          content: { ink: 'mono' },
        }),
      ),
    );
    expect(read[0]?.content).not.toMatch(/[\d.]+ [\d.]+ [\d.]+ rg/);
  });
});

describe('portrait card text and logo', () => {
  const TITLE = 'A very long title that wraps over several lines of the card for sure yes it does';

  it('caps the name at two lines and keeps a square logo clear of the text', async () => {
    const logo = { id: 'sq', bytes: makePng({ width: 20, height: 20 }) };
    const read = await readPdf(
      await render(sheet('admission', 'cr80p', { content: { title: TITLE }, images: { logo } })),
    );
    const content = read[0]?.content ?? '';
    const image = /([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\s*\/Img/.exec(content);
    expect(image).not.toBeNull();
    const [w, h, , bottom] = [1, 2, 3, 4].map((i) => Number(image?.[i])) as [
      number,
      number,
      number,
      number,
    ];
    // Contained: never taller than 16 mm, never stretched (the logo is square).
    expect(h).toBeLessThanOrEqual(16 * PT + 0.01);
    expect(w).toBeCloseTo(h, 3);
    // The name is the 10 pt semibold run: two lines at most.
    expect([...content.matchAll(/Rubik-SemiBold-\d+ 10\.0\d* Tf/g)].length).toBeLessThanOrEqual(2);
    // The first text on the face (the kicker) starts under the logo.
    const kickerBaseline = Number(/1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(content)?.[1]);
    expect(kickerBaseline + 5).toBeLessThan(bottom);
  });

  it('a wide logo shrinks to fit 24 mm instead of overflowing', async () => {
    const logo = { id: 'wide', bytes: makePng({ width: 40, height: 10 }) };
    const read = await readPdf(
      await render(sheet('admission', 'cr80p', { content: { title: TITLE }, images: { logo } })),
    );
    const image = /([\d.]+) 0 0 ([\d.]+) [\d.]+ [\d.]+ cm\s*\/Img/.exec(read[0]?.content ?? '');
    expect(Number(image?.[1])).toBeLessThanOrEqual(24 * PT + 0.01);
    expect(Number(image?.[1]) / Number(image?.[2])).toBeCloseTo(4, 2);
  });
});
