/** Workstream b owns this module. Keep `normalize`, `NormalizeOptions` and `PassView` exported. */

export { BARCODE_FORMATS } from './barcode.ts';
export { isDarkBackground } from './color.ts';
export type { NormalizeOptions } from './normalize.ts';
export { facesDiffer, normalize } from './normalize.ts';
export { autolink, parseAttributed, safeHref } from './sanitize.ts';
export { parsePassStrings } from './strings.ts';
export type * from './types.ts';
