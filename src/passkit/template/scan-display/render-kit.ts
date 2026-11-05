/** Small helpers the row renderers share. */
import { SCAN_DISPLAY_COPY } from '../../../shared/copy/scan.ts';
import type { Json } from '../../types.ts';
import { testCond } from './condition.ts';
import { sanitized } from './format.ts';
import type { ScanCond, ScanText } from './schema.ts';
import { type EvalCtx, evalText } from './text.ts';

export interface RowCtx extends EvalCtx {
  /** The document's currency, when it names one. */
  docCurrency: string | null;
}

export const COPY = SCAN_DISPLAY_COPY;
export const DASH = '\u2014';
export const MINUS = '\u2212';

export const shown = (el: { when?: ScanCond | undefined }, rc: EvalCtx): boolean =>
  !el.when || testCond(el.when, rc);

export const text = (
  value: ScanText | null | undefined,
  rc: EvalCtx,
  cap: number,
  breaks = false,
) => sanitized(evalText(value, rc), cap, breaks);

export const orNull = (value: string) => (value === '' ? null : value);

export const record = (value: unknown): Record<string, Json> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;
