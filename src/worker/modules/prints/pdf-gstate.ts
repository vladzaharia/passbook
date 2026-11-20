import type { PDFName, PDFPage, PDFRef } from 'pdf-lib';

/** Registers an ExtGState dictionary on the page and returns the name to select it with. */
export function gstate(page: PDFPage, dict: Record<string, unknown>): PDFName {
  const ctx = page.doc.context;
  const ref = ctx.register(ctx.obj({ Type: 'ExtGState', ...dict }));
  return page.node.newExtGState('G', ref);
}

/** A luminosity blend: a coloured image over grey keeps only its lightness (mono ink). */
export const luminosityState = (page: PDFPage): PDFName => gstate(page, { BM: 'Luminosity' });

/**
 * A soft mask whose alpha runs from `a0` at x0 to `a1` at x1 (page points, left to right), clamped
 * outside. Painted colour under it fades like a CSS linear-gradient to transparent.
 */
export function fadeState(
  page: PDFPage,
  fade: { x0: number; x1: number; a0: number; a1: number },
  bbox: [number, number, number, number],
): PDFName {
  const ctx = page.doc.context;
  const shading = ctx.obj({
    ShadingType: 2,
    ColorSpace: 'DeviceGray',
    Coords: [fade.x0, 0, fade.x1, 0],
    Function: { FunctionType: 2, Domain: [0, 1], C0: [fade.a0], C1: [fade.a1], N: 1 },
    Extend: [true, true],
  });
  const form: PDFRef = ctx.register(
    ctx.stream('/Sh sh', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: bbox,
      Group: { S: 'Transparency', CS: 'DeviceGray' },
      Resources: { Shading: { Sh: shading } },
    }),
  );
  return gstate(page, { SMask: { Type: 'Mask', S: 'Luminosity', G: form } });
}
