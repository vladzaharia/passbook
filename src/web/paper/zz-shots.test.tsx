import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zlibSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'vitest';
import { bakedSlugs } from '../../passkit/template/baked-fixtures.ts';
import {
  PAPER_SPECS,
  type PaperSize,
  resolvePaper,
  withKind,
} from '../../passkit/template/paper.ts';
import { blueprintPass } from '../../passkit/template/paper-blueprint-fixtures.ts';
import { paperContent } from '../../passkit/template/paper-content.ts';
import type { Personalization } from '../../passkit/types.ts';
import { toSvg } from '../../shared/pass-view/barcode-svg.ts';
import { type RenderOptions, renderPdf } from '../../worker/modules/prints/pdf-render.ts';
import { crc32 } from '../../worker/modules/templates/package/hash.ts';
import { PAPER_CSS, pageRule } from './css.ts';
import { drawPaperCode } from './drawing.ts';
import { PaperTicket } from './ticket.tsx';

const OUT = process.env.SHOT_OUT ?? '/tmp/pk-shots';
const CODE = 'PABCDEFGHIJKLMNOPQRSTUVWXYZ';
const assets = {
  fetch: async (req: Request) =>
    new Response(
      readFileSync(join(import.meta.dirname, '../../../public', new URL(req.url).pathname)),
    ),
} as RenderOptions['assets'];

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
/** A 270 px portrait-ish figure: head and shoulders on a soft ground. */
function photoPng(): Uint8Array {
  const n = 270;
  const raw = new Uint8Array((n * 3 + 1) * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * (n * 3 + 1) + 1 + x * 3;
      let c = [168 + (y >> 3), 190 + (x >> 4), 205];
      const head = (x - 135) ** 2 / 55 ** 2 + (y - 95) ** 2 / 70 ** 2 < 1;
      const body = (x - 135) ** 2 / 115 ** 2 + (y - 290) ** 2 / 120 ** 2 < 1;
      if (head) c = [224, 178, 140];
      else if (body) c = [58, 74, 110];
      raw.set(c, i);
    }
  const h = new Uint8Array(13);
  const v = new DataView(h.buffer);
  v.setUint32(0, n);
  v.setUint32(4, n);
  h.set([8, 2, 0, 0, 0], 8);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    sig,
    chunk('IHDR', h),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const PHOTO = photoPng();
const dataUri = `data:image/png;base64,${Buffer.from(PHOTO).toString('base64')}`;

const TARGET: Record<string, PaperSize> = (() => {
  const t: Record<string, PaperSize> = {};
  const set = (s: PaperSize, ...slugs: string[]) => {
    for (const x of slugs) t[`starter-${x}`] = s;
  };
  set('atb', 'boarding-pass');
  set('dl', 'transit-ticket');
  set('half', 'booking');
  set('a4', 'hotel-stay');
  set('cr80p', 'staff-badge', 'visitor-pass');
  set('cr80', 'access-card', 'credential', 'generic', 'stamp-card', 'poster-generic', 'pack');
  set('a6', 'pickup');
  return t;
})();

it('writes shots', async () => {
  mkdirSync(OUT, { recursive: true });
  const index: string[] = [];
  for (const slug of bakedSlugs()) {
    const over: Personalization = slug === 'starter-stamp-card' ? { stamps: 0 } : {};
    const { passJson, manifest, personalization } = await blueprintPass(slug, over).catch(
      async () => blueprintPass(slug, { stamps: 3 }),
    );
    const base = resolvePaper(manifest.paper);
    const sizes: [string, PaperSize][] = [['default', base.size]];
    const tgt = TARGET[slug];
    if (tgt && tgt !== base.size) sizes.push(['target', tgt]);
    for (const [tag, size] of sizes)
      for (const ink of ['colour', 'mono'] as const) {
        const d0 = {
          ...base,
          size,
          ink,
          ...(PAPER_SPECS[size].layout === 'card' ? { barcode: 'qr' as const } : {}),
        };
        const content = paperContent({
          passJson,
          manifest,
          personalization,
          design: d0,
          scanCode: 'S',
          images: ['logo', 'thumbnail', 'artwork', 'background', 'strip'],
        });
        const design = withKind(d0, content.kind);
        const name = `${slug}--${tag}-${size}-${ink}`;
        const html = renderToStaticMarkup(
          <PaperTicket
            content={content}
            design={design}
            code={CODE}
            drawing={drawPaperCode(toSvg, design.barcode, CODE)}
            mark="full"
            issued={{ generation: 1, at: '2030-01-01T10:00:00Z' }}
            assets={{ photo: content.photo ? dataUri : undefined }}
          />,
        );
        writeFileSync(
          join(OUT, `${name}.html`),
          `<!doctype html><meta charset=utf-8><style>${PAPER_CSS}\n${pageRule(design.size)}\nbody{margin:0}</style>${html}`,
        );
        const bytes = await renderPdf(
          [
            {
              design,
              content,
              code: CODE,
              issued: { generation: 1, at: '2030-01-01T10:00:00Z' },
              images: content.photo ? { photo: { id: 'p', bytes: PHOTO } } : {},
            },
          ],
          { assets },
        );
        const doc = await PDFDocument.load(bytes);
        for (let i = 0; i < doc.getPageCount(); i++) {
          const one = await PDFDocument.create();
          const [p] = await one.copyPages(doc, [i]);
          one.addPage(p);
          writeFileSync(join(OUT, `${name}.p${i + 1}.pdf`), await one.save());
        }
        index.push(`${name}\t${content.kind}\t${size}\t${doc.getPageCount()}`);
      }
  }
  writeFileSync(join(OUT, 'index.tsv'), index.join('\n'));
}, 600_000);
