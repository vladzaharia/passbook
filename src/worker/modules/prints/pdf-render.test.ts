import { env } from 'cloudflare:test';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { PAPER_SPECS, type PaperSize } from '../../../passkit/template/paper.ts';
import { toSvg } from '../../../shared/pass-view/barcode-svg.ts';
import { drawPaperCode } from '../../../web/paper/drawing.ts';
import { TINY_PNG } from '../passes/pass-test-fixtures.ts';
import { pdfFingerprint } from './pdf-cache.ts';
import { makePng } from './pdf-png-fixtures.ts';
import { codeShapes, pdfText, rasterize, readPdf } from './pdf-read.ts';
import { renderPdf } from './pdf-render.ts';
import { SAMPLE_CODE, sheet } from './pdf-render-fixtures.ts';

const PT = 72 / 25.4;
const LOGO = makePng({ width: 8, height: 8 });
const ART = makePng({ width: 16, height: 8 });
const render = (...sheets: Parameters<typeof renderPdf>[0]) =>
  renderPdf(sheets, { assets: env.ASSETS });

describe('every size renders', () => {
  it.each([
    ['a4', 1],
    ['letter', 1],
    ['half', 1],
    ['cr80', 2],
  ] as [PaperSize, number][])('%s: %i page(s) at its size', async (size, pages) => {
    const read = await readPdf(await render(sheet('admission', size)));
    expect(read).toHaveLength(pages);
    for (const p of read) {
      expect(p.size.w).toBeCloseTo(PAPER_SPECS[size].widthMm * PT, 0);
      expect(p.size.h).toBeCloseTo(PAPER_SPECS[size].heightMm * PT, 0);
    }
  });

  it.each([
    ['permit', 'half'],
    ['coupon', 'half'],
    ['membership', 'cr80'],
    ['pickup', 'letter'],
    ['permit', 'a4'],
  ] as const)('%s on %s', async (kind, size) => {
    const text = await pdfText(await render(sheet(kind, size)));
    expect(text.replace(/\s/g, '')).toContain(SAMPLE_CODE);
  });

  it('puts several tickets in one PDF, a page each (two for a card)', async () => {
    const read = await readPdf(
      await render(sheet('admission', 'a4'), sheet('admission', 'a4'), sheet('membership', 'cr80')),
    );
    expect(read).toHaveLength(4);
  });
});

const COMBOS_PDF = [
  ['admission', 'a4'],
  ['admission', 'half'],
  ['membership', 'cr80'],
  ['permit', 'half'],
  ['coupon', 'half'],
] as const;

describe('text', () => {
  it('shows who, what, when, where and the print code as real text', async () => {
    const text = await pdfText(await render(sheet('admission', 'a4')));
    for (const want of [
      'Harbour Lights: Night Two',
      'Maya Okafor',
      'General admission',
      'Sat 13 Feb 2027',
      '7:30 pm NZDT',
      'Pier 9 Amphitheatre',
      '9 Wharf Road, Wellington 6011',
      'TICKET CODE',
      'Before you go',
      'Issued with',
      'PassBook',
      'Print 2',
    ])
      expect(text).toContain(want);
    expect(text.replace(/\s/g, '')).toContain(SAMPLE_CODE);
  });

  it.each(COMBOS_PDF)('draws the footer credit by mark on %s %s', async (kind, size) => {
    const full = await pdfText(await render(sheet(kind, size)));
    expect(full).toContain('Issued with');
    expect(full).toContain('PassBook');
    const small = await pdfText(await render(sheet(kind, size, { mark: 'small' })));
    expect(small).toContain('Powered by PassBook');
    expect(small).not.toContain('Issued with');
    const none = await pdfText(await render(sheet(kind, size, { mark: 'none' })));
    expect(none).not.toContain('PassBook');
    expect(none).not.toContain('Issued with');
    expect(none.replace(/\s/g, '')).toContain(SAMPLE_CODE);
  });

  it('says the venue once on a half sheet, and never twice in one line', async () => {
    const lines = (await pdfText(await render(sheet('admission', 'half')))).split('\n');
    expect(lines.filter((l) => l.includes('Pier 9 Amphitheatre')).length).toBeGreaterThan(0);
    for (const l of lines) expect(l.split('Pier 9 Amphitheatre').length - 1).toBeLessThan(2);
    expect(lines.filter((l) => l === 'Pier 9 Amphitheatre')).toHaveLength(1);
  });

  it('keeps the credential guards: only the print code is a code', async () => {
    const text = await pdfText(await render(sheet('admission', 'a4')));
    expect(text).not.toContain('SECRET');
  });

  it.each(['Zoë Ångström', 'Ольга Петрова', 'Çağrı Öztürk', 'Łukasz Żółć'])(
    'draws %s as itself',
    async (name) => {
      let lossy = 0;
      const bytes = await renderPdf([sheet('admission', 'a4', { content: { holder: name } })], {
        assets: env.ASSETS,
        onLossy: () => lossy++,
      });
      expect(lossy).toBe(0);
      expect(await pdfText(bytes)).toContain(name);
    },
  );

  it('folds a compatibility form quietly, and says so when a mark or a character is lost', async () => {
    let lossy = 0;
    const quiet = await renderPdf([sheet('admission', 'a4', { content: { holder: 'ｆｕｌｌ' } })], {
      assets: env.ASSETS,
      onLossy: () => lossy++,
    });
    expect(lossy).toBe(0);
    expect(await pdfText(quiet)).toContain('full');
    const lost = await renderPdf([sheet('admission', 'a4', { content: { holder: '李雷' } })], {
      assets: env.ASSETS,
      onLossy: () => lossy++,
    });
    expect(lossy).toBe(1);
    expect(await pdfText(lost)).toContain('??');
  });

  it.each(['Nguyễn Thị Hương', 'Phạm Quỳnh Ánh', 'Αλέξανδρος Παπαδόπουλος', 'Ελένη Κωνσταντίνου'])(
    'draws %s as itself through the Noto Sans fallback',
    async (name) => {
      let lossy = 0;
      const bytes = await renderPdf([sheet('admission', 'a4', { content: { holder: name } })], {
        assets: env.ASSETS,
        onLossy: () => lossy++,
      });
      expect(lossy).toBe(0);
      const text = (await pdfText(bytes)).replace(/\s+/g, ' ');
      expect(text).toContain(name);
      expect(text).not.toContain('?');
    },
  );

  it('embeds Noto Sans only when a character needs it', async () => {
    const plain = await renderPdf([sheet('admission', 'a4')], { assets: env.ASSETS });
    const viet = await renderPdf([sheet('admission', 'a4', { content: { holder: 'Nguyễn' } })], {
      assets: env.ASSETS,
    });
    const hasNoto = async (b: Uint8Array) => {
      const doc = await PDFDocument.load(b, { updateMetadata: false });
      return doc.context
        .enumerateIndirectObjects()
        .some(
          ([, o]) => o instanceof PDFDict && `${o.get(PDFName.of('BaseFont'))}`.includes('Noto'),
        );
    };
    expect(await hasNoto(plain)).toBe(false);
    expect(await hasNoto(viet)).toBe(true);
  });

  it('says once when characters the fonts lack were replaced', async () => {
    let lossy = 0;
    const bytes = await renderPdf(
      [
        sheet('admission', 'a4', { content: { holder: '李雷 😀' } }),
        sheet('admission', 'a4', { content: { holder: '山田太郎' } }),
      ],
      { assets: env.ASSETS, onLossy: () => lossy++ },
    );
    expect(lossy).toBe(1);
    expect(await pdfText(bytes)).toMatch(/\?\?/);
  });
});

describe('ink', () => {
  const colourOps = /\s(?:rg|RG|k|K|sc|SC|scn|SCN)\s/;

  it('mono draws no colour operator on any size', async () => {
    for (const [kind, size] of [
      ['admission', 'a4'],
      ['admission', 'half'],
      ['permit', 'half'],
      ['coupon', 'half'],
      ['membership', 'cr80'],
    ] as const) {
      const pages = await readPdf(
        await render(
          sheet(kind, size, {
            paper: { ink: 'mono', buddy: true },
            content: { ink: 'mono' },
            mode: 'test',
            images: { logo: { id: 'l', bytes: TINY_PNG } },
          }),
        ),
      );
      for (const p of pages) expect(p.content, `${kind} ${size}`).not.toMatch(colourOps);
    }
  });

  it('colour draws the pass colour', async () => {
    const [page] = await readPdf(await render(sheet('admission', 'a4')));
    expect(page?.content).toMatch(/\s0\.\d+ 0\.\d+ 0\.\d+ rg\s/);
  });

  it('embeds the logo and art once per image', async () => {
    const bytes = await render(
      sheet('admission', 'a4', {
        images: { logo: { id: 'logo', bytes: LOGO }, art: { id: 'art', bytes: ART } },
      }),
      sheet('admission', 'a4', { images: { logo: { id: 'logo', bytes: LOGO } } }),
    );
    const pages = await readPdf(bytes);
    expect(pages[0]?.content).toMatch(/\/Img\S* Do/);
    // Two PNGs with alpha: an image and its soft mask each, the shared logo embedded once.
    expect(new TextDecoder('latin1').decode(bytes).match(/\/Subtype \/Image/g)?.length).toBe(4);
  });

  it('a file that is not a PNG is left out and reported', async () => {
    const bad: string[] = [];
    const bytes = await renderPdf(
      [
        sheet('admission', 'a4', {
          images: { logo: { id: 'x', bytes: new Uint8Array([1, 2, 3]) } },
        }),
      ],
      {
        assets: env.ASSETS,
        onImageError: (id) => bad.push(id),
      },
    );
    expect(bad).toEqual(['x']);
    expect(await pdfText(bytes)).toContain('Harbour Lights: Night Two');
  });
});

describe('test mode', () => {
  it('marks the ticket and the page, and leaves a live one clean', async () => {
    const test = await pdfText(await render(sheet('admission', 'a4', { mode: 'test' })));
    expect(test).toContain('TEST TICKET · NOT VALID FOR ENTRY');
    expect(test).toContain('TEST · NOT VALID');
    const live = await pdfText(await render(sheet('admission', 'a4')));
    expect(live).not.toContain('TEST');
  });
});

describe('buddy and fold marks', () => {
  it('draws the buddy only when asked, and not on the permit or the card', async () => {
    const buddyOps = (kind: Parameters<typeof sheet>[0], size: PaperSize, buddy: boolean) =>
      render(sheet(kind, size, { paper: { buddy } })).then(
        async (b) => (await readPdf(b))[0]?.content.length ?? 0,
      );
    expect(await buddyOps('admission', 'a4', true)).toBeGreaterThan(
      await buddyOps('admission', 'a4', false),
    );
    expect(await buddyOps('permit', 'half', true)).toBe(await buddyOps('permit', 'half', false));
    expect(await buddyOps('membership', 'cr80', true)).toBe(
      await buddyOps('membership', 'cr80', false),
    );
  });

  it('prints fold marks on A4 only when the design has them', async () => {
    expect(await pdfText(await render(sheet('admission', 'a4')))).toContain('Fold');
    expect(
      await pdfText(await render(sheet('admission', 'a4', { paper: { fold: false } }))),
    ).not.toMatch(/^Fold$/m);
  });
});

describe('the code', () => {
  it.each([
    ['admission', 'a4', 45],
    ['admission', 'letter', 45],
    ['admission', 'half', 38],
    ['permit', 'half', 38],
    ['membership', 'cr80', 30],
  ] as const)('%s on %s is a %i mm QR with a 4 module quiet zone', async (kind, size, mm) => {
    const [page] = await readPdf(await render(sheet(kind, size)));
    const shapes = codeShapes(page as never);
    expect(shapes).toBeDefined();
    const xs = (shapes?.polygons.flat() ?? []).map((p) => p[0]);
    expect((Math.max(...xs) - Math.min(...xs)) / PT).toBeCloseTo(mm, 2);
    // The white box is the symbol and 4 modules each side (the card's is a rounded tile, not a rectangle).
    if (size !== 'cr80') expect((shapes?.box?.w ?? 0) / PT).toBeCloseTo((mm * 33) / 25, 2);
  });

  it('draws exactly the modules the barcode engine made', async () => {
    const [page] = await readPdf(await render(sheet('admission', 'a4')));
    const shapes = codeShapes(page as never);
    const drawing = drawPaperCode(toSvg, 'qr', SAMPLE_CODE);
    expect(shapes?.evenOdd).toBe(true);
    const fromPdf = rasterize(shapes as never, 2, 0);
    const wanted = drawing?.paths[0]?.d.split('Z').filter(Boolean).length;
    expect(shapes?.polygons.length).toBe(wanted);
    // 25 modules across: 25 columns of equal width.
    expect(fromPdf.width / 25).toBeGreaterThan(1);
  });

  it('is Code 128 at 90 mm on a coupon', async () => {
    const [page] = await readPdf(await render(sheet('coupon', 'half')));
    const xs = (codeShapes(page as never)?.polygons.flat() ?? []).map((p) => p[0]);
    expect((Math.max(...xs) - Math.min(...xs)) / PT).toBeCloseTo(90, 1);
  });
});

describe('cache fingerprint', () => {
  const key = (s: ReturnType<typeof sheet>) =>
    pdfFingerprint({ design: s.design, content: s.content, mode: s.mode });

  it('changes with buddy, ink, size, mode and the words, and not otherwise', async () => {
    const base = await key(sheet('admission', 'a4'));
    expect(await key(sheet('admission', 'a4'))).toBe(base);
    for (const other of [
      sheet('admission', 'a4', { paper: { buddy: true } }),
      sheet('admission', 'a4', { paper: { ink: 'mono' } }),
      sheet('admission', 'letter'),
      sheet('admission', 'a4', { paper: { fold: false } }),
      sheet('admission', 'a4', { mode: 'test' }),
      sheet('admission', 'a4', { content: { holder: 'Someone Else' } }),
    ])
      expect(await key(other)).not.toBe(base);
  });
});
