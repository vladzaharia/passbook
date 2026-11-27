/**
 * The anonymous playground's data, built at deploy (tools/build-developers.ts): for every starter
 * blueprint the pass.json its sample makes, the files it loads, and the printed ticket as a static
 * image. Same planner as the preview endpoint, minus signing and the database, so a visitor's
 * browser calls nothing. Loaded through Vite's runner, like render.tsx.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import { stampedView } from '../../../passkit/build-assets.ts';
import { resolvePaper } from '../../../passkit/template/paper.ts';
import { bestImage, imageSlots } from '../../../passkit/template/paper-assets.ts';
import { paperContent } from '../../../passkit/template/paper-content.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { toSvg } from '../../../shared/pass-view/barcode-svg.ts';
import type { OutFile } from '../../developers/model/types.ts';
import { PAPER_CSS } from '../../paper/css.ts';
import { drawPaperCode } from '../../paper/drawing.ts';
import { PaperTicket } from '../../paper/ticket.tsx';
import type { BlueprintPreview, BlueprintPreviews } from './model.ts';
import { planPreview } from './preview-plan.ts';

/** A code of the print code's shape, so the ticket draws a real QR; never a real ticket's. */
const SAMPLE_CODE = 'PSAMPLEABCDEFGHIJKLMNOPQRST';
const PAPER_WIDTH = 520;
const PAGE_GAP = 28;
/** The sheet is XML inside the image, so its drawings need their namespace spelled out. */
const SVG_NS = 'http://www.w3.org/2000/svg';
const dataUri = (root: string, slug: string, name: string | undefined): string | undefined => {
  if (!name) return undefined;
  const bytes = readFileSync(join(root, 'templates', slug, name));
  return `data:image/png;base64,${bytes.toString('base64')}`;
};

function paperImage(root: string, t: ResolvedTemplate, slug: string, passJson: PassJson) {
  const manifest = t.manifest as TemplateManifest;
  const design = resolvePaper(manifest.paper);
  const content = paperContent({
    passJson,
    manifest,
    personalization: manifest.sample ?? {},
    design,
    holderName: 'Sample holder',
    images: imageSlots(t.assets),
  });
  const drawing = drawPaperCode(toSvg, design.barcode, SAMPLE_CODE);
  const body = renderToStaticMarkup(
    <PaperTicket
      content={content}
      design={design}
      code={SAMPLE_CODE}
      mark="full"
      drawing={drawing}
      testBand
      assets={{
        logo: dataUri(root, slug, bestImage(t.assets, 'logo')),
        art: dataUri(root, slug, content.art ? bestImage(t.assets, content.art) : undefined),
      }}
    />,
  );
  // The pages stack as they print: one sheet, or a card's front and back (a wider gap than the sheet's 12 px, so the faces read as two).
  const sheet = /data-size="[^"]*" style="--w:([\d.]+);--h:([\d.]+)/.exec(body);
  const ratio = sheet ? Number(sheet[2]) / Number(sheet[1]) : 297 / 210;
  const pages = body.split('<div class="pp-fit"').length - 1;
  const height = Math.round(PAPER_WIDTH * ratio * pages + PAGE_GAP * (pages - 1));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAPER_WIDTH}" height="${height}" viewBox="0 0 ${PAPER_WIDTH} ${height}">` +
    `<foreignObject width="${PAPER_WIDTH}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${PAPER_WIDTH}px">` +
    `<style>${PAPER_CSS}.pp-fit+.pp-fit{margin-top:${PAGE_GAP}px}</style>${body.replaceAll('<svg ', `<svg xmlns="${SVG_NS}" `)}</div></foreignObject></svg>`;
  return { svg, height };
}

export function blueprintPreviews(
  root: string,
  origin: string,
): { json: string; files: OutFile[] } {
  const items: BlueprintPreview[] = [];
  const files: OutFile[] = [];
  for (const b of bakedTemplates.filter((t) => t.blueprint)) {
    const template: ResolvedTemplate = {
      id: b.id,
      version: b.version,
      orgId: null,
      origin: 'baked',
      manifest: b.manifest,
      passJson: b.passJson as PassJson,
      assets: b.assets,
      styles: b.styles,
    };
    const { inputs, sample, ...manifest } = b.manifest as unknown as Record<string, unknown>;
    const input = (sample ?? {}) as Record<string, never>;
    const passJson = planPreview({ template, input, origin });
    const names = new Set([
      ...(stampedView(template, input) ?? template.assets).map((a) => a.name),
      ...((b.manifest as TemplateManifest).previewOnlyAssets ?? []),
    ]);
    const paper = paperImage(root, template, b.slug, passJson);
    const src = `/developers/paper/${b.slug}.svg`;
    files.push({ file: src, body: paper.svg });
    items.push({
      id: b.id,
      slug: b.slug,
      name: b.name,
      description: b.description,
      inputs: (inputs ?? {}) as BlueprintPreview['inputs'],
      sample: input,
      manifest,
      source: b.passJson as Record<string, unknown>,
      origin,
      passJson: passJson as unknown as Record<string, unknown>,
      assetBaseUrl: `/templates/${b.slug}/${b.version}`,
      assetNames: [...names],
      assets: b.assets
        .filter((a) => a.slot !== 'source')
        .map((a) => ({
          name: a.name,
          slot: a.slot,
          scale: a.scale,
          ...(a.width ? { width: a.width } : {}),
          ...(a.height ? { height: a.height } : {}),
        })),
      paper: { src, width: PAPER_WIDTH, height: paper.height },
    });
  }
  const previews: BlueprintPreviews = { schema: 1, items };
  return { json: JSON.stringify(previews), files };
}
