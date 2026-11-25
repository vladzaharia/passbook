import { PDF_RENDER_VERSION } from './pdf-render.ts';

/** JSON with sorted keys, so the same value always makes the same text. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/**
 * A short hash of everything that changes the PDF: the drawing's version, the design (size, ink,
 * buddy, fold, barcode), the words, the code, test mode, the print number and time, and the images
 * by name. A cached PDF is good only while this matches (and the pass is at the same version).
 */
export async function pdfFingerprint(parts: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonical({ render: PDF_RENDER_VERSION, parts }));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
