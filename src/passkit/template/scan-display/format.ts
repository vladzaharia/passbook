/**
 * Display formatting (DM 1.9) and text hygiene (DM 1.11 rule 9). Pure: Intl only.
 * System words here ("just now", "min ago") are English in v1; author text is never translated.
 */
import type { Json } from '../../types.ts';

export const FILTERS = [
  'date',
  'time',
  'datetime',
  'day',
  'ago',
  'count',
  'money',
  'upper',
  'duration',
] as const;
export type DisplayFilter = (typeof FILTERS)[number];

export interface FormatCtx {
  locale: string;
  timeZone: string;
  now: number;
  /** ISO 4217 code for the `money` filter. */
  currency?: string | null;
}

const DAY_MS = 86_400_000;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ASCII = /^[\x20-\x7e]*$/;

export const graphemes = (value: string): string[] =>
  Array.from(segmenter.segment(value), (part) => part.segment);

export const graphemeLength = (value: string): number =>
  ASCII.test(value) ? value.length : graphemes(value).length;

/**
 * Cuts to `cap` graphemes, the last one being an ellipsis when anything was cut. The rendered
 * contract counts UTF-16 units, so a string that fits the graphemes but not the units is cut too.
 */
export function truncate(value: string, cap: number): string {
  if (value.length <= cap && graphemeLength(value) <= cap) return value;
  const kept: string[] = [];
  let units = 0;
  for (const part of graphemes(value)) {
    if (kept.length >= cap - 1 || units + part.length > cap - 1) break;
    kept.push(part);
    units += part.length;
  }
  return `${kept.join('').trimEnd()}\u2026`;
}

const BIDI = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
export const HAS_HIDDEN = /[\p{Cc}\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/** NFC, no control or bidi-override characters, collapsed whitespace. Notes keep single line breaks. */
export function sanitize(value: string, keepBreaks = false): string {
  const text = value.normalize('NFC').replace(BIDI, '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  if (!keepBreaks)
    return text
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return text
    .replace(/[^\P{Cc}\n]/gu, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export const sanitized = (value: string, cap: number, keepBreaks = false): string =>
  truncate(sanitize(value, keepBreaks), cap);

export function plain(value: Json | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function toNumber(value: Json | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A date-only value is a calendar day: it formats the same in every zone. */
export function toInstant(value: Json | undefined): { ms: number; zone: string | null } | null {
  if (typeof value === 'number') return Number.isFinite(value) ? { ms: value, zone: null } : null;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(DATE_ONLY.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isNaN(ms) ? null : { ms, zone: DATE_ONLY.test(value) ? 'UTC' : null };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function dateFormat(locale: string, timeZone: string, options: Intl.DateTimeFormatOptions) {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (!found) {
    try {
      found = new Intl.DateTimeFormat(locale, { timeZone, ...options });
    } catch {
      found = new Intl.DateTimeFormat('en', { timeZone: 'UTC', ...options });
    }
    if (formatters.size > 200) formatters.clear();
    formatters.set(key, found);
  }
  return found;
}

const spaces = (text: string) => text.replace(/\s+/g, ' ');

function ymd(ms: number, timeZone: string) {
  const parts = dateFormat('en-US', timeZone, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Whole calendar days since the epoch, in `timeZone`. */
export function dayIndex(ms: number, timeZone: string): number {
  const { y, m, d } = ymd(ms, timeZone);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

const shortDate = (ms: number, ctx: FormatCtx, zone: string) => {
  const sameYear = ymd(ms, zone).y === ymd(ctx.now, zone).y;
  return spaces(
    dateFormat(ctx.locale, zone, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    }).format(ms),
  );
};

function ago(ms: number, ctx: FormatCtx): string {
  const diff = ctx.now - ms;
  if (diff < -60_000) return shortDate(ms, ctx, ctx.timeZone);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} h ago`;
  const days = dayIndex(ctx.now, ctx.timeZone) - dayIndex(ms, ctx.timeZone);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return shortDate(ms, ctx, ctx.timeZone);
}

function day(ms: number, ctx: FormatCtx): string {
  const delta = dayIndex(ms, ctx.timeZone) - dayIndex(ctx.now, ctx.timeZone);
  if (delta >= -1 && delta <= 1) {
    const word = new Intl.RelativeTimeFormat(ctx.locale, { numeric: 'auto' }).format(delta, 'day');
    return word.charAt(0).toLocaleUpperCase(ctx.locale) + word.slice(1);
  }
  if (delta > 1 && delta < 7)
    return dateFormat(ctx.locale, ctx.timeZone, { weekday: 'short' }).format(ms);
  return shortDate(ms, ctx, ctx.timeZone);
}

export function countText(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

export function moneyText(value: number, locale: string, currency?: string | null): string {
  if (!currency) return countText(value, locale);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
  } catch {
    return countText(value, locale);
  }
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 60) {
    const rest = minutes % 60;
    return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
  }
  return minutes >= 1 ? `${minutes} min` : `${Math.max(0, Math.floor(ms / 1000))} s`;
}

/** One filter over one value. An empty or unusable value gives "" (the text then hides). */
export function applyFilter(name: string, value: Json | undefined, ctx: FormatCtx): string {
  if (value === undefined || value === null || value === '') return '';
  if (name === 'upper') return plain(value).toLocaleUpperCase(ctx.locale);
  if (name === 'count' || name === 'money' || name === 'duration') {
    const n = toNumber(value);
    if (n === null) return '';
    if (name === 'count') return countText(n, ctx.locale);
    if (name === 'duration') return duration(n);
    return moneyText(n, ctx.locale, ctx.currency);
  }
  const instant = toInstant(value);
  if (!instant) return '';
  const zone = instant.zone ?? ctx.timeZone;
  const { ms } = instant;
  switch (name) {
    case 'date':
      return spaces(
        dateFormat(ctx.locale, zone, { year: 'numeric', month: 'short', day: 'numeric' }).format(
          ms,
        ),
      );
    case 'time':
      return spaces(
        dateFormat(ctx.locale, zone, { hour: 'numeric', minute: '2-digit' }).format(ms),
      );
    case 'datetime': {
      const sameYear = ymd(ms, zone).y === ymd(ctx.now, zone).y;
      return spaces(
        dateFormat(ctx.locale, zone, {
          month: 'short',
          day: 'numeric',
          ...(sameYear ? {} : { year: 'numeric' }),
          hour: 'numeric',
          minute: '2-digit',
        }).format(ms),
      );
    }
    case 'day':
      return day(ms, ctx);
    case 'ago':
      return ago(ms, ctx);
    default:
      return '';
  }
}
