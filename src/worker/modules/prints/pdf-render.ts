/**
 * The printed tickets as a PDF, drawn with pdf-lib from the same content model and layout boxes as
 * the print page (web/paper/ticket.tsx). Text is Rubik and JetBrains Mono embedded as subsets, so it
 * stays real, selectable text; characters those fonts lack become "?" and are reported once.
 */
import { PDFDocument, type PDFImage } from 'pdf-lib';
import { PAPER_SPECS, type PaperDesign } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import { toSvg } from '../../../shared/pass-view/barcode-svg.ts';
import { drawPaperCode } from '../../../web/paper/drawing.ts';
import type { Issued } from '../../../web/paper/ticket-text.ts';
import { drawCardBack, drawCardFront } from './pdf-draw-card.ts';
import { drawFull } from './pdf-draw-full.ts';
import { drawCoupon, drawPermit } from './pdf-draw-small.ts';
import { type AssetSource, embedFonts, type PdfFonts } from './pdf-fonts.ts';
import { Pen } from './pdf-kit.ts';
import type { PdfImages, Sheet } from './pdf-sheet.ts';

/** Part of every cache fingerprint: bump it when the drawing changes. */
export const PDF_RENDER_VERSION = 'pt4-1';

/** A PNG a sheet draws, with an id that names its content (an etag). */
export interface ImageSource {
  id: string;
  bytes: Uint8Array;
}

/** One ticket of a PDF: its design, words, print code and images. */
export interface PrintSheet {
  design: PaperDesign;
  content: PaperContent;
  code: string;
  mode?: 'live' | 'test';
  issued?: Issued;
  images?: { logo?: ImageSource; art?: ImageSource };
}

export interface RenderOptions {
  /** The static assets binding: the fonts are read from `/fonts/pdf/`. */
  assets: AssetSource;
  /** Called once when a character could not be drawn. */
  onLossy?: () => void;
  /** Called with the image id when a PNG cannot be embedded. */
  onImageError?: (id: string) => void;
}

function drawSheet(doc: PDFDocument, fonts: PdfFonts, sheet: Sheet, state: { lossy: boolean }) {
  const { content: c, design } = sheet;
  const spec = PAPER_SPECS[design.size];
  const mono = c.ink === 'mono';
  const page = () => doc.addPage([spec.widthMm * (72 / 25.4), spec.heightMm * (72 / 25.4)]);
  const pen = () => new Pen(page(), fonts, mono, state, spec.heightMm);
  if (design.size === 'cr80') {
    drawCardFront(pen(), sheet);
    drawCardBack(pen(), sheet);
  } else if (c.kind === 'permit') drawPermit(pen(), sheet);
  else if (c.kind === 'coupon') drawCoupon(pen(), sheet);
  else drawFull(pen(), sheet, design.size === 'half');
}

export async function renderPdf(
  sheets: readonly PrintSheet[],
  options: RenderOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await embedFonts(doc, options.assets);
  const state = { lossy: false };
  const embedded = new Map<string, PDFImage | undefined>();
  const embed = async (src: ImageSource | undefined): Promise<PDFImage | undefined> => {
    if (!src) return undefined;
    if (!embedded.has(src.id)) {
      try {
        embedded.set(src.id, await doc.embedPng(src.bytes));
      } catch {
        // A file that is not a PNG is left out; the caller logs it.
        embedded.set(src.id, undefined);
        options.onImageError?.(src.id);
      }
    }
    return embedded.get(src.id);
  };
  for (const s of sheets) {
    const images: PdfImages = {};
    const logo = await embed(s.images?.logo);
    const art = await embed(s.images?.art);
    if (logo) images.logo = logo;
    if (art) images.art = art;
    drawSheet(
      doc,
      fonts,
      {
        content: s.content,
        design: s.design,
        code: s.code,
        drawing: drawPaperCode(toSvg, s.design.barcode, s.code),
        issued: s.issued,
        mode: s.mode,
        images,
      },
      state,
    );
  }
  doc.setTitle(`${sheets[0]?.content.brand ?? 'PassBook'} ticket`);
  doc.setProducer('PassBook');
  if (state.lossy) options.onLossy?.();
  return doc.save();
}
