import type { PassJson } from '../types.ts';

/**
 * Test-only. The foundation validator rejects Code 39; this swaps it for Code 128 during validation
 * and nothing else. Remove once the pass-format validator accepts Code 39.
 */
export function shimValidator<
  T extends { validatePass: (pass: PassJson, ...rest: never[]) => unknown },
>(original: T): T {
  return {
    ...original,
    validatePass: (pass: PassJson, ...rest: never[]) =>
      original.validatePass(
        {
          ...pass,
          barcodes: pass.barcodes?.map((b) => ({
            ...b,
            format: b.format === 'PKBarcodeFormatCode39' ? 'PKBarcodeFormatCode128' : b.format,
          })),
        },
        ...rest,
      ),
  };
}
