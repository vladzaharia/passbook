/** Test support: reads back what a ticket PDF draws (text, operators, the code's shapes). */
import {
  decodePDFRawStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  type PDFStream,
} from 'pdf-lib';
import { CODE_TAG } from './pdf-code.ts';

const decoder = new TextDecoder('latin1');
const textOf = (stream: PDFStream): string =>
  decoder.decode(decodePDFRawStream(stream as PDFRawStream).decode());

/** glyph id to text, from a ToUnicode CMap's bfchar and bfrange blocks. */
function cmap(source: string): Map<number, string> {
  const map = new Map<number, string>();
  const text = (hex: string) =>
    String.fromCodePoint(
      ...(hex.match(/.{4}/g) ?? []).reduce<number[]>((out, unit, i, all) => {
        const n = Number.parseInt(unit, 16);
        const prev = out[out.length - 1];
        // A surrogate pair is one code point.
        if (n >= 0xdc00 && n <= 0xdfff && prev !== undefined && i > 0 && all[i - 1]) {
          out[out.length - 1] = 0x10000 + ((prev - 0xd800) << 10) + (n - 0xdc00);
        } else out.push(n);
        return out;
      }, []),
    );
  for (const m of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const p of (m[1] ?? '').matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi))
      map.set(Number.parseInt(p[1] ?? '', 16), text(p[2] ?? ''));
  for (const m of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const p of (m[1] ?? '').matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
      const [lo, hi] = [Number.parseInt(p[1] ?? '', 16), Number.parseInt(p[2] ?? '', 16)];
      const base = (p[3] ?? '').match(/.{4}/g) ?? [];
      for (let g = lo; g <= hi; g++)
        map.set(
          g,
          text(
            [
              ...base.slice(0, -1),
              (Number.parseInt(base.at(-1) ?? '0', 16) + g - lo).toString(16).padStart(4, '0'),
            ].join(''),
          ),
        );
    }
  return map;
}

export interface PdfPage {
  /** The page's content stream operators as text. */
  content: string;
  /** Width and height in points. */
  size: { w: number; h: number };
  /** The text drawn, one entry per show-text operator, in drawing order. */
  lines: string[];
}

/** Every page of a PDF: its operators and the text it shows (through each font's ToUnicode map). */
export async function readPdf(bytes: Uint8Array): Promise<PdfPage[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents && 'asArray' in contents ? contents.asArray() : [contents];
    const content = streams
      .map((s) => {
        const stream = s && doc.context.lookup(s);
        return stream instanceof PDFRawStream ? textOf(stream) : '';
      })
      .join('\n');
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    const maps = new Map<string, Map<number, string>>();
    for (const [name, ref] of fonts?.entries() ?? []) {
      const font = doc.context.lookup(ref, PDFDict);
      const uni = font.lookup(PDFName.of('ToUnicode'));
      if (uni instanceof PDFRawStream) maps.set(name.asString().slice(1), cmap(textOf(uni)));
    }
    const lines: string[] = [];
    let current = new Map<number, string>();
    for (const m of content.matchAll(/\/(\S+) [\d.]+ Tf|<([0-9a-f]+)>\s*Tj/gi)) {
      if (m[1]) current = maps.get(m[1]) ?? new Map();
      else
        lines.push(
          (m[2]?.match(/.{4}/g) ?? [])
            .map((g) => current.get(Number.parseInt(g, 16)) ?? '')
            .join(''),
        );
    }
    const { width, height } = page.getSize();
    return { content, size: { w: width, h: height }, lines };
  });
}

/** All text of the PDF, one drawn string per line. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  return (await readPdf(bytes)).flatMap((p) => p.lines).join('\n');
}

export interface CodeShapes {
  /** Filled polygons or rectangles of the symbol, in points from the page's bottom-left. */
  polygons: [number, number][][];
  /** The white box behind it (symbol and quiet zone), in points. */
  box: { x: number; y: number; w: number; h: number } | undefined;
  evenOdd: boolean;
}

/** The marked block a code is drawn in: its polygons and the white box before it. */
export function codeShapes(page: PdfPage): CodeShapes | undefined {
  const at = page.content.indexOf(`/${CODE_TAG} BMC`);
  if (at < 0) return undefined;
  const block = page.content.slice(at, page.content.indexOf('EMC', at));
  const polygons: [number, number][][] = [];
  let open: [number, number][] = [];
  for (const m of block.matchAll(
    /(-?[\d.]+) (-?[\d.]+) (m|l)\b|(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\b|\bh\b/g,
  )) {
    if (m[3] === 'm') open = [[Number(m[1]), Number(m[2])]];
    else if (m[3] === 'l') open.push([Number(m[1]), Number(m[2])]);
    else if (m[4] !== undefined) {
      const [x, y, w, h] = [m[4], m[5], m[6], m[7]].map(Number) as [number, number, number, number];
      polygons.push([
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ]);
    } else if (open.length > 0) {
      polygons.push(open);
      open = [];
    }
  }
  const before = [
    ...page.content.slice(0, at).matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\b/g),
  ].at(-1);
  const [x, y, w, h] = before
    ? ([1, 2, 3, 4].map((i) => Number(before[i])) as [number, number, number, number])
    : [0, 0, 0, 0];
  return { polygons, box: before ? { x, y, w, h } : undefined, evenOdd: block.includes('f*') };
}

/**
 * The code as a bitmap (`true` is black), `scale` pixels per point, with a white border of `border`
 * points, filled with the even-odd rule row by row.
 */
export function rasterize(
  shapes: CodeShapes,
  scale: number,
  border: number,
): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const xs = shapes.polygons.flat().map((p) => p[0]);
  const ys = shapes.polygons.flat().map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const width = Math.ceil((x1 - x0 + 2 * border) * scale);
  const height = Math.ceil((y1 - y0 + 2 * border) * scale);
  const black = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    // Page y grows upward; the bitmap's rows grow downward.
    const y = y1 + border - (row + 0.5) / scale;
    const cuts: number[] = [];
    for (const poly of shapes.polygons)
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i] as [number, number];
        const [bx, by] = poly[(i + 1) % poly.length] as [number, number];
        if (ay > y !== by > y) cuts.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    cuts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k += 2) {
      const from = Math.max(0, Math.round(((cuts[k] as number) - x0 + border) * scale));
      const to = Math.min(width, Math.round(((cuts[k + 1] as number) - x0 + border) * scale));
      for (let col = from; col < to; col++) black[row * width + col] = 1;
    }
  }
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let i = 0; i < black.length; i++) {
    const v = black[i] ? 0 : 255;
    data.set([v, v, v, 255], i * 4);
  }
  return { width, height, data };
}
