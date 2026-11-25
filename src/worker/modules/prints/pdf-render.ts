/**
 * The printed tickets as a PDF, drawn with pdf-lib from the same content model and layout boxes as
 * the print page (web/paper/ticket.tsx). Text is Rubik and JetBrains Mono embedded as subsets, so it
 * stays real, selectable text; characters those fonts lack become "?" and are reported once.
 */
import { PDFDocument } from 'pdf-lib';
import { PAPER_SPECS, type PaperDesign } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import { COUPON_BAND } from '../../../passkit/template/paper-geometry.ts';
import type { BrandMark } from '../../../shared/contracts/orgs.ts';
import { toSvg } from '../../../shared/pass-view/barcode-svg.ts';
import { drawPaperCode } from '../../../web/paper/drawing.ts';
import type { Issued } from '../../../web/paper/ticket-text.ts';
import { needsFallback } from './pdf-coverage.ts';
import { drawCardBack, drawCardFront } from './pdf-draw-card.ts';
import { drawFull } from './pdf-draw-full.ts';
import { drawCoupon, drawPermit } from './pdf-draw-small.ts';
import { type AssetSource, embedFonts, type PdfFonts } from './pdf-fonts.ts';
import { Pen } from './pdf-kit.ts';
import { embedPixels, type PdfPicture, type PictureFit, readPng } from './pdf-png.ts';
import type { PdfImages, Sheet } from './pdf-sheet.ts';

/** Part of every cache fingerprint: bump it when the drawing changes. */
export const PDF_RENDER_VERSION = 'pt4-4';

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
  /** The org's footer choice. */
  mark: BrandMark;
  images?: { logo?: ImageSource; art?: ImageSource };
}

export interface RenderOptions {
  /** The static assets binding: the fonts are read from `/fonts/pdf/`. */
  assets: AssetSource;
  /** Called once when a character could not be drawn. */
  onLossy?: () => void;
  /** Called with the image id when a PNG is left out: `invalid` (not drawable) or `limit` (too many images). */
  onImageError?: (id: string, reason: 'invalid' | 'limit') => void;
}

/** Distinct images one PDF embeds: each costs a decode, and a bulk of 50 must stay inside the CPU budget. */
export const MAX_DISTINCT_IMAGES = 12;

/** The box an image fills on this sheet, for the print resolution it needs. */
function fitOf(sheet: PrintSheet, role: 'logo' | 'art'): PictureFit {
  const { design, content } = sheet;
  if (role === 'logo') return { wMm: 24, hMm: 20, mode: 'contain' };
  if (design.size === 'cr80') return { wMm: 85.6, hMm: 54, mode: 'cover' };
  if (content.kind === 'coupon') return { wMm: 189, hMm: COUPON_BAND, mode: 'cover' };
  return { wMm: (PAPER_SPECS[design.size].widthMm - 16) / 2, hMm: 44, mode: 'cover' };
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
  const fonts = await embedFonts(doc, options.assets, needsFallback(sheets.map((s) => s.content)));
  const state = { lossy: false };
  const embedded = new Map<string, PdfPicture | undefined>();
  let distinct = 0;
  const embed = (src: ImageSource | undefined, fit: PictureFit): PdfPicture | undefined => {
    if (!src) return undefined;
    const key = `${src.id}|${fit.mode}|${Math.round(fit.wMm)}x${Math.round(fit.hMm)}`;
    if (embedded.has(key)) return embedded.get(key);
    let picture: PdfPicture | undefined;
    if (distinct >= MAX_DISTINCT_IMAGES) options.onImageError?.(src.id, 'limit');
    else {
      distinct++;
      // Bounded decode: a refused file (animated, oversized, a bomb) is drawn without.
      const pixels = readPng(src.bytes, fit);
      if (pixels) picture = embedPixels(doc, pixels);
      else options.onImageError?.(src.id, 'invalid');
    }
    embedded.set(key, picture);
    return picture;
  };
  for (const s of sheets) {
    const images: PdfImages = {};
    const logo = embed(s.images?.logo, fitOf(s, 'logo'));
    const art = embed(s.images?.art, fitOf(s, 'art'));
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
        mark: s.mark,
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
