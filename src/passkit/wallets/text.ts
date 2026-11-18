/**
 * Shared text rules of every compiler (architecture 3.3 step 5, owner answer Q20). Display text
 * over a provider limit is cut at a grapheme boundary and ends in `…`. An identity value is never
 * cut: one that does not fit makes the pass `Not offered` for that provider.
 */
import type { FidelityItem } from './types.ts';

export const ELLIPSIS = '…';

export interface TextLimit {
  /** `chars` counts code points; `bytes` counts UTF-8. */
  unit: 'chars' | 'bytes';
  max: number;
}

const MARKUP = /<\/?[A-Za-z][^>]*>/gu;
const HAS_MARKUP = /<\/?[A-Za-z][^>]*>/u;
// C0 and C1 controls except newline.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu;
const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Plain text a provider can show: no tags, no controls, CRLF as LF, surrounding space trimmed. */
export function sanitizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(MARKUP, '')
    .replace(CONTROLS, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .trim();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: finding controls is the point
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/**
 * Single-line display text a provider may show as is: not blank, no control character at all (a
 * newline, tab or carriage return included), no line or paragraph separator, no bidirectional
 * override or isolate, and no markup. Nothing is trimmed or rewritten.
 */
export function isPlainLine(value: string): boolean {
  return value.trim().length > 0 && !ANY_CONTROL.test(value) && !HAS_MARKUP.test(value);
}

/** True when `sanitizeText` would not change the value and it is non-empty. */
export function isPlainText(value: string): boolean {
  return value.length > 0 && sanitizeText(value) === value;
}

export function measure(value: string, unit: TextLimit['unit']): number {
  if (unit === 'bytes') return encoder.encode(value).length;
  let count = 0;
  for (const _ of value) count++;
  return count;
}

export function fits(value: string, limit: TextLimit): boolean {
  return measure(value, limit.unit) <= limit.max;
}

export interface Shortened {
  text: string;
  shortened: boolean;
}

/** Cuts display text to `limit`, ending in `…`, at a grapheme boundary. Fitting text is returned as is. */
export function shorten(value: string, limit: TextLimit): Shortened {
  if (fits(value, limit)) return { text: value, shortened: false };
  const room = limit.max - measure(ELLIPSIS, limit.unit);
  if (room < 0) return { text: '', shortened: true };
  let kept = '';
  for (const { segment } of segmenter.segment(value)) {
    if (measure(kept + segment, limit.unit) > room) break;
    kept += segment;
  }
  return { text: `${kept.trimEnd()}${ELLIPSIS}`, shortened: true };
}

export type TextFit =
  | { status: 'ok'; text: string }
  | { status: 'shortened'; text: string }
  | { status: 'too-long'; text: string };

/**
 * Applies a limit by kind. `display` text is shortened. `identity` text (barcode message, member
 * id, gift card number, ticket number) is returned unchanged and `too-long` when it does not fit.
 */
export function fitText(value: string, limit: TextLimit, kind: 'display' | 'identity'): TextFit {
  if (fits(value, limit)) return { status: 'ok', text: value };
  if (kind === 'identity') return { status: 'too-long', text: value };
  return { status: 'shortened', text: shorten(value, limit).text };
}

/**
 * The template-level note for a limited text slot, once per field. A value that was cut says so;
 * an input with no `maxLength` under the limit "may be shortened"; a bounded one reports nothing.
 */
export function lengthItem(args: {
  path: string;
  limit: TextLimit;
  /** The longest value the input allows, in the limit's unit. Absent: unbounded. */
  declaredMax?: number;
  /** The value of this pass or sample. */
  value?: string;
}): FidelityItem | null {
  const { path, limit, declaredMax, value } = args;
  const unit = limit.unit === 'bytes' ? 'bytes' : 'characters';
  if (value !== undefined && !fits(value, limit))
    return {
      capability: 'text.length',
      path,
      support: 'difference',
      message: `Shortened to ${limit.max} ${unit}.`,
    };
  if (declaredMax !== undefined && declaredMax <= limit.max) return null;
  return {
    capability: 'text.length',
    path,
    support: 'difference',
    message: `May be shortened to ${limit.max} ${unit}.`,
  };
}
