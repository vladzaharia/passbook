/** Workstream b owns this module. Keep `normalize`, `NormalizeOptions` and `PassView` exported. */

export { BARCODE_FORMATS } from './barcode.ts';
export { isDarkBackground } from './color.ts';
export { distinguishingLine } from './distinguish.ts';
export type { NormalizeOptions } from './normalize.ts';
export { facesDiffer, normalize } from './normalize.ts';
export { autolink, parseAttributed, safeHref } from './sanitize.ts';
export { withStatusWord } from './status-field.ts';
export { parsePassStrings } from './strings.ts';
export type * from './types.ts';
