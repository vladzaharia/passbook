import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';

/** Static subsets of the brand fonts, served from `public/fonts/pdf` (tools/build-pdf-fonts.sh). */
const FILES = {
  regular: 'Rubik-Regular',
  medium: 'Rubik-Medium',
  semibold: 'Rubik-SemiBold',
  bold: 'Rubik-Bold',
  mono: 'JetBrainsMono-Bold',
} as const;
export type FontKey = keyof typeof FILES;
/** The Noto Sans weight behind each face (public/fonts/pdf, from assets/fonts/noto). */
const ALT = {
  regular: 'NotoSans-Regular',
  medium: 'NotoSans-Regular',
  semibold: 'NotoSans-Bold',
  bold: 'NotoSans-Bold',
  mono: 'NotoSans-Bold',
} as const;

export interface FontFace {
  font: PDFFont;
  /** Noto Sans for the characters Rubik lacks; present only when a document needs it. */
  alt?: { font: PDFFont; has: Set<number> };
  /** hhea ascent and descent as fractions of the em, for placing a baseline in a line box. */
  ascent: number;
  descent: number;
  has: Set<number>;
}
export type PdfFonts = Record<FontKey, FontFace>;

/** The part of the static assets binding the fonts need; tests pass a plain object. */
export interface AssetSource {
  fetch(request: Request): Promise<Response>;
}

/** Font bytes live as long as the isolate: they are static and a few hundred kB in all. */
const bytesCache = new Map<string, Uint8Array>();

async function fontBytes(assets: AssetSource, name: string): Promise<Uint8Array> {
  const hit = bytesCache.get(name);
  if (hit) return hit;
  const res = await assets.fetch(new Request(`https://assets.invalid/fonts/pdf/${name}.ttf`));
  if (!res.ok) throw new Error(`PDF font ${name} is missing (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  bytesCache.set(name, bytes);
  return bytes;
}

/** ascent and descent from the hhea table, in em fractions. */
function metrics(bytes: Uint8Array): { ascent: number; descent: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = view.getUint16(4);
  const find = (tag: string) => {
    for (let i = 0; i < tables; i++) {
      const at = 12 + i * 16;
      if (String.fromCharCode(...bytes.subarray(at, at + 4)) === tag) return view.getUint32(at + 8);
    }
    return -1;
  };
  const hhea = find('hhea');
  const head = find('head');
  const upem = head < 0 ? 1000 : view.getUint16(head + 18);
  if (hhea < 0) return { ascent: 0.935, descent: 0.25 };
  return { ascent: view.getInt16(hhea + 4) / upem, descent: -view.getInt16(hhea + 6) / upem };
}

/** Embeds the five faces as subsets: only the glyphs a document draws are kept. Noto Sans joins them when `withAlt`. */
export async function embedFonts(
  doc: PDFDocument,
  assets: AssetSource,
  withAlt = false,
): Promise<PdfFonts> {
  doc.registerFontkit(fontkit);
  const out = {} as PdfFonts;
  const alts = new Map<string, { font: PDFFont; has: Set<number> }>();
  for (const [key, name] of Object.entries(FILES) as [FontKey, string][]) {
    const bytes = await fontBytes(assets, name);
    const font = await doc.embedFont(bytes, { subset: true });
    out[key] = { font, ...metrics(bytes), has: new Set(font.getCharacterSet()) };
    if (!withAlt) continue;
    const altName = ALT[key];
    if (!alts.has(altName)) {
      const alt = await doc.embedFont(await fontBytes(assets, altName), { subset: true });
      alts.set(altName, { font: alt, has: new Set(alt.getCharacterSet()) });
    }
    out[key].alt = alts.get(altName) as { font: PDFFont; has: Set<number> };
  }
  return out;
}

/**
 * Maps text to what a face can draw. A compatibility form folds quietly ("ｆｕｌｌ" is "full"); a
 * letter whose marks must be stripped, or a character with no near form, is set in "?" or its base
 * letter and `state.lossy` is raised. Rubik covers Latin, Latin extended and Cyrillic; the Noto
 * Sans fallback adds Vietnamese and Greek. CJK, emoji, Hebrew and Arabic are in neither.
 */
export function drawable(face: FontFace, text: string, state: { lossy: boolean }): string {
  const has = (cp: number) => face.has.has(cp) || (face.alt?.has.has(cp) ?? false);
  const ok = (s: string) => [...s].every((c) => has(c.codePointAt(0) ?? 0));
  let out = '';
  for (const ch of text.normalize('NFC').replace(/\s+/g, ' ')) {
    const folded = ch.normalize('NFKC');
    const base = ch.normalize('NFKD').replace(/\p{M}/gu, '');
    if (ok(ch)) out += ch;
    else if (ok(folded)) out += folded;
    else {
      state.lossy = true;
      out += base && ok(base) ? base : '?';
    }
  }
  return out;
}

/**
 * Splits drawable text into runs by font. A word with any character Rubik lacks is set whole in
 * Noto Sans, so its letters match; the spaces between two such words go with them.
 */
export function runs(face: FontFace, text: string): { font: PDFFont; text: string }[] {
  const alt = face.alt;
  if (!alt) return text ? [{ font: face.font, text }] : [];
  const chars = [...text];
  const useAlt = chars.map(() => false);
  for (let i = 0, start = 0; i <= chars.length; i++) {
    if (i < chars.length && chars[i] !== ' ') continue;
    const word = chars.slice(start, i);
    if (word.some((c) => !face.has.has(c.codePointAt(0) ?? 0)))
      for (let k = start; k < i; k++) useAlt[k] = true;
    start = i + 1;
  }
  chars.forEach((c, i) => {
    if (c === ' ' && useAlt[i - 1] && useAlt[i + 1]) useAlt[i] = true;
  });
  const out: { font: PDFFont; text: string }[] = [];
  for (const [i, c] of chars.entries()) {
    const font = useAlt[i] ? alt.font : face.font;
    const last = out.at(-1);
    if (last && last.font === font) last.text += c;
    else out.push({ font, text: c });
  }
  return out;
}
