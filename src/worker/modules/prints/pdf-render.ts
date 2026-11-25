/**
 * The printed tickets as a PDF, drawn with pdf-lib from the same content model and layout boxes as
 * the print page (web/paper/ticket.tsx). Text is Rubik and JetBrains Mono embedded as subsets, so it
 * stays real, selectable text; characters those fonts lack become "?" and are reported once.
 */
import {
  concatTransformationMatrix,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { PAPER_SPECS, type PaperDesign, sheetApplies } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import { COUPON_BAND, halfFit, sheetLayout } from '../../../passkit/template/paper-geometry.ts';
import type { BrandMark } from '../../../shared/contracts/orgs.ts';
import { PRINT_BULK_MAX } from '../../../shared/contracts/prints.ts';
import { toSvg } from '../../../shared/pass-view/barcode-svg.ts';
import { drawPaperCode } from '../../../web/paper/drawing.ts';
import type { Issued } from '../../../web/paper/ticket-text.ts';
import { needsFallback } from './pdf-coverage.ts';
import { drawCardBack, drawCardFront } from './pdf-draw-card.ts';
import { drawCoupon } from './pdf-draw-coupon.ts';
import { drawFull } from './pdf-draw-full.ts';
import { drawPermit } from './pdf-draw-small.ts';
import { drawStrip } from './pdf-draw-stub.ts';
import { type AssetSource, embedFonts, type PdfFonts } from './pdf-fonts.ts';
import { COLORS, Pen, PT } from './pdf-kit.ts';
import { embedPixels, type PdfPicture, type PictureFit, readPng } from './pdf-png.ts';
import type { PdfImages, Sheet } from './pdf-sheet.ts';

/** Part of every cache fingerprint: bump it when the drawing changes. */
export const PDF_RENDER_VERSION = 'pt4-8';

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
  images?: { logo?: ImageSource; art?: ImageSource; photo?: ImageSource };
}

export interface RenderOptions {
  /** The static assets binding: the fonts are read from `/fonts/pdf/`. */
  assets: AssetSource;
  /** Called once when a character could not be drawn. */
  onLossy?: () => void;
  /** Called with the image id when a PNG is left out: `invalid` (not drawable) or `limit` (too many images). */
  onImageError?: (id: string, reason: 'invalid' | 'limit') => void;
}

/** Member photos one PDF embeds: one per pass, so a bulk of badges holds as many as its cap. */
export const MAX_PHOTOS = PRINT_BULK_MAX;

/** Distinct images one PDF embeds: each costs a decode, and a bulk of 50 must stay inside the CPU budget. */
export const MAX_DISTINCT_IMAGES = 12;

/** The box an image fills on this sheet, for the print resolution it needs. */
function fitOf(sheet: PrintSheet, role: 'logo' | 'art' | 'photo'): PictureFit {
  const { design, content } = sheet;
  if (role === 'logo') return { wMm: 24, hMm: 20, mode: 'contain' };
  if (role === 'photo') return { wMm: 36, hMm: 36, mode: 'cover' };
  const spec = PAPER_SPECS[design.size];
  if (spec.layout === 'card') return { wMm: spec.widthMm, hMm: spec.heightMm, mode: 'cover' };
  if (content.kind === 'coupon') return { wMm: 189, hMm: COUPON_BAND, mode: 'cover' };
  return { wMm: (spec.widthMm - 16) / 2, hMm: 44, mode: 'cover' };
}

/**
 * A holder's print on one A4 or Letter sheet: each face is drawn in its own frame and moved into its
 * slot (a folded card's back turned half a turn). The full-colour front gets its bleed first.
 */
function drawOnSheet(doc: PDFDocument, fonts: PdfFonts, sheet: Sheet, state: { lossy: boolean }) {
  const { design, content: c } = sheet;
  const spec = PAPER_SPECS[design.size];
  const layout = sheetLayout(design.size, design.sheet ?? 'a4');
  const { w, h } = layout.page;
  const mono = c.ink === 'mono';
  const page = doc.addPage([w * PT, h * PT]);
  const sheetPen = new Pen(page, fonts, mono, state, h);
  for (const [x1, y1, x2, y2] of layout.cuts) sheetPen.line(x1, y1, x2, y2, '#000000', 0.2);
  for (const [i, face] of layout.faces.entries()) {
    const b = face.box;
    const { top, right, bottom, left } = face.bleed;
    if (!mono && (top || right || bottom || left))
      sheetPen.fillBox(
        { x: b.x - left, y: b.y - top, w: b.w + left + right, h: b.h + top + bottom },
        c.colors.bg,
      );
    const pen = new Pen(page, fonts, mono, state, spec.heightMm);
    // Card-local mm from the card's bottom-left to the sheet; a turned face flips about its centre.
    const bottomY = h - b.y - spec.heightMm;
    pen.ops(
      pushGraphicsState(),
      face.rotated
        ? concatTransformationMatrix(-1, 0, 0, -1, (b.x + b.w) * PT, (bottomY + b.h) * PT)
        : concatTransformationMatrix(1, 0, 0, 1, b.x * PT, bottomY * PT),
    );
    if (spec.layout === 'strip') drawStrip(pen, sheet);
    else if (i === 0) drawCardFront(pen, sheet);
    else drawCardBack(pen, sheet);
    pen.ops(popGraphicsState());
  }
  // Last, so the crease shows over the front's colour.
  if (layout.fold) sheetPen.line(...layout.fold, COLORS.rule, 0.25, [1.2, 0.8]);
}

function drawSheet(doc: PDFDocument, fonts: PdfFonts, sheet: Sheet, state: { lossy: boolean }) {
  const { content: c, design } = sheet;
  const spec = PAPER_SPECS[design.size];
  const mono = c.ink === 'mono';
  const page = () => doc.addPage([spec.widthMm * PT, spec.heightMm * PT]);
  const pen = () => new Pen(page(), fonts, mono, state, spec.heightMm);
  if (design.sheet && sheetApplies(design.size)) drawOnSheet(doc, fonts, sheet, state);
  else if (spec.layout === 'card') {
    drawCardFront(pen(), sheet);
    drawCardBack(pen(), sheet);
  } else if (spec.layout === 'strip') drawStrip(pen(), sheet);
  else if (c.kind === 'permit' || c.kind === 'coupon') {
    const draw = c.kind === 'permit' ? drawPermit : drawCoupon;
    const p = pen();
    if (design.size === 'half-letter') {
      // The 210 x 148 design, scaled to the page height from the top-left and centred.
      const fit = halfFit(design.size);
      p.ops(
        pushGraphicsState(),
        concatTransformationMatrix(
          fit.scale,
          0,
          0,
          fit.scale,
          fit.dx * PT,
          spec.heightMm * PT * (1 - fit.scale),
        ),
      );
      draw(p, sheet);
      p.ops(popGraphicsState());
    } else draw(p, sheet);
  } else drawFull(pen(), sheet, spec.layout === 'half');
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
  let photos = 0;
  const embed = (
    src: ImageSource | undefined,
    fit: PictureFit,
    isPhoto = false,
  ): PdfPicture | undefined => {
    if (!src) return undefined;
    const key = `${src.id}|${fit.mode}|${Math.round(fit.wMm)}x${Math.round(fit.hMm)}`;
    if (embedded.has(key)) return embedded.get(key);
    let picture: PdfPicture | undefined;
    if (isPhoto ? photos >= MAX_PHOTOS : distinct >= MAX_DISTINCT_IMAGES)
      options.onImageError?.(src.id, 'limit');
    else {
      if (isPhoto) photos++;
      else distinct++;
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
    const art =
      PAPER_SPECS[s.design.size].layout === 'strip'
        ? undefined
        : embed(s.images?.art, fitOf(s, 'art'));
    if (logo) images.logo = logo;
    if (art) images.art = art;
    const photo = embed(s.images?.photo, fitOf(s, 'photo'), true);
    if (photo) images.photo = photo;
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
