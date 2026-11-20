import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import type { PaperKind, PaperSize } from '../../passkit/template/paper.ts';
import { codeShapes, rasterize, readPdf } from '../../worker/modules/prints/pdf-read.ts';
import { type RenderOptions, renderPdf } from '../../worker/modules/prints/pdf-render.ts';
import { SAMPLE_CODE, sheet } from '../../worker/modules/prints/pdf-render-fixtures.ts';

const require = createRequire(import.meta.url);
/** The static assets binding, from public/: the PDF fonts. */
const assets = {
  fetch: async (req: Request) =>
    new Response(
      readFileSync(join(import.meta.dirname, '../../../public', new URL(req.url).pathname)),
    ),
} as RenderOptions['assets'];

beforeAll(async () => {
  await prepareZXingModule({
    overrides: {
      wasmBinary: readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))
        .buffer as ArrayBuffer,
    },
    fireImmediately: true,
  });
});

const CASES: [PaperKind, PaperSize, string][] = [
  ['admission', 'a4', 'QRCode'],
  ['admission', 'letter', 'QRCode'],
  ['admission', 'half', 'QRCode'],
  ['permit', 'half', 'QRCode'],
  ['membership', 'cr80', 'QRCode'],
  ['coupon', 'half', 'Code128'],
];

describe('the code in a rendered PDF', () => {
  it.each(CASES)(
    '%s on %s decodes as %s at 300 dpi (QR also at 110)',
    async (kind, size, format) => {
      const bytes = await renderPdf([sheet(kind, size)], { assets });
      const [page] = await readPdf(bytes);
      const shapes = codeShapes(page as never);
      expect(shapes).toBeDefined();
      // A Code 128 module is 0.27 mm: 300 dpi is its floor; a QR module (1.2 mm and up) decodes at 110.
      for (const dpi of format === 'Code128' ? [300] : [300, 110]) {
        const { width, height, data } = rasterize(shapes as never, dpi / 72, 18);
        const [hit] = await readBarcodes(
          { data, width, height, colorSpace: 'srgb' as const },
          {
            formats: [format as 'QRCode'],
            tryHarder: true,
          },
        );
        expect(hit?.text, `${dpi} dpi`).toBe(SAMPLE_CODE);
      }
    },
  );

  it('is unchanged by buddy, test mode and mono', async () => {
    const bytes = await renderPdf(
      [
        sheet('admission', 'a4', {
          paper: { buddy: true, ink: 'mono' },
          content: { ink: 'mono' },
          mode: 'test',
        }),
      ],
      { assets },
    );
    const [page] = await readPdf(bytes);
    const { width, height, data } = rasterize(codeShapes(page as never) as never, 300 / 72, 18);
    const [hit] = await readBarcodes(
      { data, width, height, colorSpace: 'srgb' as const },
      { formats: ['QRCode'] },
    );
    expect(hit?.text).toBe(SAMPLE_CODE);
  });
});
