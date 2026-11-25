// What changed on a pass, in the admin's words: field labels, option labels and readable dates.
// One implementation for import rows, the change-run preview, the version diff and the pass page.
import type { Json } from '../contracts/common.ts';
import type { FieldChange } from '../contracts/issuing.ts';
import { formatDayIn } from '../format-date.ts';
import { CALENDAR_ZONE, isCalendarMidnight } from '../time-zone.ts';
import { type InputField, inputFields, isDateField } from './fields.ts';

export interface DiffOptions {
  /** The zone dates are read in: the org's, else `DEFAULT_TIME_ZONE`. */
  timeZone: string;
  locale?: string;
}

const times = new Map<string, Intl.DateTimeFormat>();
function timeFormat(timeZone: string, locale: string, h23: boolean): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${h23}`;
  let f = times.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, {
      hour: h23 ? '2-digit' : 'numeric',
      minute: '2-digit',
      timeZone,
      ...(h23 ? { hourCycle: 'h23' as const } : {}),
    });
    times.set(key, f);
  }
  return f;
}

const empty = (v: Json | undefined): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** A date-time at midnight in the zone reads as a day; any other time adds the time of day. */
function formatDate(value: string, o: Required<DiffOptions>): string {
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(dayOnly ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(ms)) return value;
  // A bare calendar day has no zone: it never moves a day.
  if (dayOnly || isCalendarMidnight(value)) return formatDayIn(ms, CALENDAR_ZONE, o.locale);
  const day = formatDayIn(ms, o.timeZone, o.locale);
  const at = timeFormat(o.timeZone, o.locale, true).formatToParts(ms);
  const midnight = at.every((p) => p.type === 'literal' || p.value === '00');
  return midnight ? day : `${day}, ${timeFormat(o.timeZone, o.locale, false).format(ms)}`;
}

/** One value as the form shows it; null when empty. */
export function formatValue(
  value: Json | undefined,
  f: InputField,
  options: DiffOptions,
): string | null {
  if (empty(value)) return null;
  const o = { timeZone: options.timeZone, locale: options.locale ?? 'en-US' };
  if (typeof value === 'string') {
    const option = f.options?.find((x) => x.value === value);
    if (option) return option.label;
    return isDateField(f) ? formatDate(value, o) : value;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString(o.locale);
  if (Array.isArray(value)) return value.length === 1 ? '1 item' : `${value.length} items`;
  return 'Set';
}

const same = (a: Json | undefined, b: Json | undefined): boolean =>
  (empty(a) && empty(b)) || JSON.stringify(a) === JSON.stringify(b);

/**
 * The template inputs whose value differs between `before` and `after`, in form order. Inputs the
 * template does not declare are left out, and so are changes that read the same (a re-written date).
 */
export function fieldChanges(
  schema: unknown,
  before: Readonly<Record<string, Json>> | null,
  after: Readonly<Record<string, Json>>,
  options: DiffOptions,
): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of inputFields(schema)) {
    const a = before?.[f.key];
    const b = after[f.key];
    if (same(a, b)) continue;
    const from = formatValue(a, f, options);
    const to = formatValue(b, f, options);
    if (from === to) continue;
    out.push({ key: f.key, label: f.label, from, to });
  }
  return out;
}
