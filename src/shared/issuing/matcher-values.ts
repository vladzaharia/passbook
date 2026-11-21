// Value signals: what a column's cells say about the field they belong in.
import type { MappingDateFormat } from '../contracts/issuing.ts';
import { strictEmail } from '../email.ts';
import { transform } from '../mapping/transform.ts';
import type { InputField } from './fields.ts';

/** "From values" needs this share of the non-empty cells to fit, over at least `VALUES_MIN` cells. */
export const VALUES_FIT = 0.9;
export const VALUES_MIN = 5;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/;
const FORMATS: readonly MappingDateFormat[] = ['iso', 'ymd', 'mdy', 'dmy'];

const parses = (value: string, format: MappingDateFormat): boolean =>
  format === 'iso'
    ? ISO_TIME.test(value) && Number.isFinite(Date.parse(value))
    : transform(value, { from: '', transform: { kind: 'date', options: { input: format } } }) !==
      undefined;

export interface DateRead {
  format: MappingDateFormat | null;
  /** Formats that read every parsed cell equally well: more than one is a clash to ask about. */
  choices: MappingDateFormat[];
  parsed: number;
  total: number;
}

/** The one format that reads the most cells; on a M/D/Y vs D/M/Y tie, no format and both choices. */
export function readDates(values: readonly string[]): DateRead | null {
  const scores = FORMATS.map((f) => ({ f, n: values.filter((v) => parses(v, f)).length }));
  const best = Math.max(...scores.map((s) => s.n));
  if (best === 0) return null;
  const top = scores.filter((s) => s.n === best).map((s) => s.f);
  // `iso` and `ymd` read the same day; `iso` keeps the time zone, so it wins that tie.
  const choices = top.includes('iso') ? ['iso' as const] : top;
  return {
    format: choices.length === 1 ? (choices[0] as MappingDateFormat) : null,
    choices: choices.length === 1 ? [] : choices,
    parsed: best,
    total: values.length,
  };
}

/** The option a cell names by key or label, ignoring case; null when it names none. */
export function optionOf(
  value: string,
  options: NonNullable<InputField['options']>,
): string | null {
  const v = value.trim().toLowerCase();
  const hit = options.find((o) => o.value.toLowerCase() === v || o.label.toLowerCase() === v);
  return hit ? hit.value : null;
}

/** Distinct cells, most common first (ties keep file order). */
export function valueCounts(values: readonly string[]): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

/** The share of cells that fit, or 0 below the minimum sample. */
export function shareFitting(values: readonly string[], ok: (v: string) => boolean): number {
  if (values.length < VALUES_MIN) return 0;
  return values.filter(ok).length / values.length;
}

export const isEmail = (v: string): boolean => strictEmail(v) !== null;
