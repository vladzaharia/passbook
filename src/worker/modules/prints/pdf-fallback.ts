import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';
import { PAPER_SPECS, type PaperDesign } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import { type PaperPlain, paperPlain } from '../../../passkit/template/paper-text.ts';
import { groupPrintCode, PRINT_COPY } from '../../../shared/copy/print.ts';
import { toSvg } from '../../../shared/pass-view/barcode-svg.ts';
import { drawPaperCode } from '../../../web/paper/drawing.ts';

const PT = 72 / 25.4;
const INK = rgb(0, 0, 0);

/** One ticket of a PDF: its design, words and the print code. */
export interface PrintSheet {
  design: PaperDesign;
  content: PaperContent;
  code: string;
}

interface Fonts {
  text: PDFFont;
  bold: PDFFont;
}

/** The standard fonts hold Latin-1 only; `safe` is the last guard so drawing text never throws. */
const safe = (font: PDFFont, s: string): string => {
  const set = new Set(font.getCharacterSet());
  return [...s].map((ch) => (set.has(ch.codePointAt(0) ?? 0) ? ch : '?')).join('');
};

/**
 * Maps text to what the font can draw: a character it lacks becomes its closest Latin-1 form (NFKD,
 * marks stripped: "Ł" stays "?", "ｆｕｌｌ" becomes "full") or "?". `lossy` is set when any "?" was made.
 */
function fold(font: PDFFont, s: string, state: { lossy: boolean }): string {
  const set = new Set(font.getCharacterSet());
  const ok = (ch: string) => set.has(ch.codePointAt(0) ?? 0);
  let out = '';
  for (const ch of s.replace(/\s+/g, ' ')) {
    if (ok(ch)) out += ch;
    else {
      const near = [...ch.normalize('NFKD').replace(/\p{M}/gu, '')];
      if (near.length > 0 && near.every(ok)) out += near.join('');
      else {
        out += '?';
        state.lossy = true;
      }
    }
  }
  return out;
}

type DrawSheet = Omit<PrintSheet, 'content'> & { content: PaperPlain };

function foldSheet(font: PDFFont, sheet: PrintSheet, state: { lossy: boolean }): DrawSheet {
  const f = (v: string) => fold(font, v, state);
  const c = paperPlain(sheet.content);
  return {
    ...sheet,
    content: {
      brand: f(c.brand),
      event: f(c.event),
      ...(c.date === undefined ? {} : { date: f(c.date) }),
      ...(c.venue === undefined ? {} : { venue: f(c.venue) }),
      ...(c.holder === undefined ? {} : { holder: f(c.holder) }),
      ...(c.type === undefined ? {} : { type: f(c.type) }),
      ...(c.seat === undefined ? {} : { seat: f(c.seat) }),
      ...(c.terms === undefined ? {} : { terms: f(c.terms) }),
      extras: c.extras.map((e) => ({
        ...(e.label === undefined ? {} : { label: f(e.label) }),
        text: f(e.text),
      })),
    },
  };
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of safe(font, text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

interface Code {
  drawing: NonNullable<ReturnType<typeof drawPaperCode>>;
  /** Width of the whole drawing in points; the symbol alone is the design's 30-45 mm (QR) or 66-100 mm. */
  width: number;
  scale: number;
}

function codeOf(sheet: DrawSheet): Code | null {
  const { design, code } = sheet;
  const drawing = drawPaperCode(toSvg, design.barcode, code);
  if (!drawing) return null;
  const spec = PAPER_SPECS[design.size];
  const mm = (design.barcode === 'qr' ? spec.qrMm : spec.barMm) * (drawing.whole / drawing.symbol);
  return { drawing, width: mm * PT, scale: (mm * PT) / drawing.whole };
}

/** Draws the code as vector paths with its top-left at (left, top); returns its height. */
function drawCode(page: PDFPage, c: Code, left: number, top: number): number {
  const [minX = 0, minY = 0, , h = 0] = c.drawing.viewBox.split(' ').map(Number);
  for (const path of c.drawing.paths) {
    const at = { x: left - minX * c.scale, y: top + minY * c.scale, scale: c.scale };
    if (path.strokeWidth)
      page.drawSvgPath(path.d, {
        ...at,
        borderColor: INK,
        borderWidth: Number(path.strokeWidth) * c.scale,
      });
    else page.drawSvgPath(path.d, { ...at, color: INK, borderWidth: 0 });
  }
  return h * c.scale;
}

/** Type sizes in points per paper size, and how many lines the title may take. */
const TYPE = {
  a4: { brand: 12, event: 30, date: 16, venue: 14, value: 14, code: 14, lines: 4, gap: 6 },
  letter: { brand: 12, event: 30, date: 16, venue: 14, value: 14, code: 14, lines: 4, gap: 6 },
  half: { brand: 9, event: 22, date: 12, venue: 11, value: 11, code: 11, lines: 3, gap: 4 },
  cr80: { brand: 6.5, event: 10.5, date: 6.5, venue: 6, value: 6.5, code: 5.5, lines: 2, gap: 1.5 },
} as const;

/** Half sheets and cards put the code in a right column, as the HTML design does; A4 and Letter stack it. */
function drawSheet(page: PDFPage, sheet: DrawSheet, f: Fonts): void {
  const { design, content } = sheet;
  const spec = PAPER_SPECS[design.size];
  const small = design.size === 'half' || design.size === 'cr80';
  const card = design.size === 'cr80';
  const t = TYPE[design.size];
  const w = spec.widthMm * PT;
  const margin = (card ? 3.5 : small ? 10 : 16) * PT;
  const inner = w - 2 * margin;
  const code = codeOf(sheet);
  const gap = small ? 8 * PT : 0;
  const column = small ? Math.min(code?.width ?? 0, inner / 2) : 0;
  const textWidth = inner - (column ? column + gap : 0);
  let y = spec.heightMm * PT - margin;
  const line = (text: string, font: PDFFont, pt: number, maxLines = 99): void => {
    const lines = wrap(font, text, pt, textWidth);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = `${(lines[maxLines - 1] ?? '').slice(0, -3)}...`;
    }
    for (const l of lines) {
      y -= pt * 1.2;
      page.drawText(l, { x: margin, y, size: pt, font, color: INK });
    }
  };
  const brandSize = t.brand;
  const typeText = content.type && !card ? safe(f.bold, content.type.toUpperCase()) : '';
  y -= brandSize;
  page.drawText(safe(f.bold, content.brand.toUpperCase()), {
    x: margin,
    y,
    size: brandSize,
    font: f.bold,
    color: INK,
  });
  if (typeText)
    page.drawText(typeText, {
      x: margin + inner - f.bold.widthOfTextAtSize(typeText, brandSize),
      y,
      size: brandSize,
      font: f.bold,
      color: INK,
    });
  y -= t.gap + 2;
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + inner, y },
    thickness: 1,
    color: INK,
  });
  const below = y;
  y -= small ? 4 : 14;
  line(content.event, f.bold, t.event, t.lines);
  y -= t.gap / 2;
  if (content.date) line(content.date, f.bold, t.date);
  if (content.venue) line(content.venue, f.text, t.venue);
  y -= t.gap;
  const info = [
    card && content.type ? ['Type', content.type] : null,
    content.holder ? ['Name', content.holder] : null,
    content.seat ? ['Seat', content.seat] : null,
    ...content.extras.map((e) => [e.label ?? '', e.text]),
  ].filter((x): x is string[] => x !== null);
  for (const [label = '', text = ''] of info) {
    y -= t.gap / 2;
    if (label && !card) line(label.toUpperCase(), f.bold, 8);
    line(text, f.bold, t.value);
  }
  const codeLeft = small ? margin + inner - column : margin;
  const codeWidth = small ? column : inner;
  let at = card ? below - 2 : small ? below - 8 : y - 14;
  if (code) at -= drawCode(page, code, codeLeft, at);
  const typed = (text: string, font: PDFFont, pt: number) => {
    for (const l of wrap(font, text, pt, codeWidth)) {
      at -= pt * 1.3;
      page.drawText(l, { x: codeLeft, y: at, size: pt, font, color: INK });
    }
  };
  at -= card ? 1 : small ? 4 : 12;
  if (!card) typed(PRINT_COPY.code.toUpperCase(), f.bold, 8);
  typed(groupPrintCode(sheet.code), f.bold, t.code);
  if (!card) typed(PRINT_COPY.codeNote, f.text, small ? 7 : 9);
  if (content.terms && !card) {
    const lines = wrap(f.text, content.terms, 8, textWidth).slice(0, small ? 4 : 8);
    for (const [i, l] of lines.entries())
      page.drawText(l, {
        x: margin,
        y: margin + (lines.length - 1 - i) * 10,
        size: 8,
        font: f.text,
        color: INK,
      });
  }
}

/**
 * The tickets as a PDF: the print page's words and its bwip-js code, drawn with pdf-lib on pages of
 * the design's size. Latin-1 text only (other characters are folded or become "?"); it scans.
 */
export async function fallbackPdf(
  sheets: readonly PrintSheet[],
  onLossy?: () => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    text: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const state = { lossy: false };
  for (const sheet of sheets) {
    const spec = PAPER_SPECS[sheet.design.size];
    const page = doc.addPage([spec.widthMm * PT, spec.heightMm * PT]);
    drawSheet(page, foldSheet(fonts.text, sheet, state), fonts);
  }
  if (state.lossy) onLossy?.();
  return doc.save();
}
