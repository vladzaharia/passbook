import type { Json } from '../../passkit/types.ts';

export interface FormatSpec {
  dateStyle?: unknown;
  timeStyle?: unknown;
  isRelative?: unknown;
  ignoresTimeZone?: unknown;
  numberStyle?: unknown;
  currencyCode?: unknown;
}

export interface FormatContext {
  locale: string;
  now: Date;
  timeZone?: string;
}

export interface Formatted {
  text: string;
  /** ISO string when the value was treated as a date. */
  dateTime?: string;
  warning?: string;
}

const STYLES: Record<string, 'short' | 'medium' | 'long' | 'full' | undefined> = {
  PKDateStyleNone: undefined,
  PKDateStyleShort: 'short',
  PKDateStyleMedium: 'medium',
  PKDateStyleLong: 'long',
  PKDateStyleFull: 'full',
};

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
const DAY = 86_400_000;

export function safeLocale(locale: string | undefined): { locale: string; bad: boolean } {
  if (!locale) return { locale: 'en', bad: false };
  try {
    return { locale: Intl.getCanonicalLocales(locale.replace(/_/g, '-'))[0] ?? 'en', bad: false };
  } catch {
    return { locale: 'en', bad: true };
  }
}

function dayNumber(d: Date, timeZone: string | undefined): number {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const [y, m, day] = p.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day) / DAY;
}

function relative(date: Date, hasTime: boolean, ctx: FormatContext): string {
  const rtf = new Intl.RelativeTimeFormat(ctx.locale, { numeric: 'auto' });
  const diff = date.getTime() - ctx.now.getTime();
  if (hasTime && Math.abs(diff) < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (hasTime && Math.abs(diff) < DAY) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(dayNumber(date, ctx.timeZone) - dayNumber(ctx.now, ctx.timeZone), 'day');
}

function formatDate(value: string, spec: FormatSpec, ctx: FormatContext): Formatted {
  const dateStyle = STYLES[String(spec.dateStyle)];
  const timeStyle = STYLES[String(spec.timeStyle)];
  if (!dateStyle && !timeStyle) return { text: value };
  let date = new Date(value);
  let timeZone = ctx.timeZone;
  if (spec.ignoresTimeZone === true) {
    // Show the wall-clock time written in the string, whatever zone the viewer is in.
    const w = WALL.exec(value);
    if (w) {
      date = new Date(
        Date.UTC(
          Number(w[1]),
          Number(w[2]) - 1,
          Number(w[3]),
          Number(w[4] ?? 0),
          Number(w[5] ?? 0),
          Number(w[6] ?? 0),
        ),
      );
      timeZone = 'UTC';
    }
  }
  if (Number.isNaN(date.getTime())) return { text: value, warning: 'field.date.invalid' };
  if (spec.isRelative === true) {
    return {
      text: relative(date, timeStyle !== undefined, { ...ctx, timeZone }),
      dateTime: value,
    };
  }
  const text = new Intl.DateTimeFormat(ctx.locale, { dateStyle, timeStyle, timeZone }).format(date);
  return { text, dateTime: value };
}

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  if (n < 100) return (TENS[Math.floor(n / 10)] ?? '') + (n % 10 ? `-${ONES[n % 10]}` : '');
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${below1000(n % 100)}` : ''}`;
}

/** English only; Intl has no spell-out. Callers fall back to decimal outside the range. */
export function spellOut(n: number): string | undefined {
  if (!Number.isInteger(n) || Math.abs(n) >= 1e9) return undefined;
  if (n < 0) return `minus ${spellOut(-n)}`;
  const parts: string[] = [];
  for (const [size, name] of [
    [1e6, 'million'],
    [1e3, 'thousand'],
  ] as const) {
    if (n >= size) {
      parts.push(`${below1000(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n > 0 || parts.length === 0) parts.push(below1000(n));
  return parts.join(' ');
}

function formatNumber(n: number, spec: FormatSpec, ctx: FormatContext): Formatted {
  const raw = String(n);
  if (typeof spec.currencyCode === 'string' && spec.currencyCode) {
    try {
      return {
        text: new Intl.NumberFormat(ctx.locale, {
          style: 'currency',
          currency: spec.currencyCode,
        }).format(n),
      };
    } catch {
      return { text: raw, warning: 'field.currency.invalid' };
    }
  }
  switch (spec.numberStyle) {
    case 'PKNumberStyleDecimal':
      return { text: new Intl.NumberFormat(ctx.locale).format(n) };
    case 'PKNumberStylePercent':
      return { text: new Intl.NumberFormat(ctx.locale, { style: 'percent' }).format(n) };
    case 'PKNumberStyleScientific':
      return {
        text: new Intl.NumberFormat(ctx.locale, {
          notation: 'scientific',
          maximumFractionDigits: 6,
        }).format(n),
      };
    case 'PKNumberStyleSpellOut':
      return spellOut(n) !== undefined
        ? { text: spellOut(n) as string }
        : { text: new Intl.NumberFormat(ctx.locale).format(n), warning: 'field.spellout.range' };
    default:
      return { text: raw };
  }
}

/** Format a field value per its dateStyle/timeStyle/numberStyle/currencyCode keys. */
export function formatValue(
  value: Json | undefined,
  spec: FormatSpec,
  ctx: FormatContext,
): Formatted {
  if (value === null || value === undefined) return { text: '' };
  const wantsDate = spec.dateStyle !== undefined || spec.timeStyle !== undefined;
  const wantsNumber = spec.numberStyle !== undefined || spec.currencyCode !== undefined;
  if (typeof value === 'string') {
    if (wantsDate) return formatDate(value, spec, ctx);
    if (wantsNumber && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      return formatNumber(Number(value), spec, ctx);
    }
    return { text: value };
  }
  if (typeof value === 'number') {
    return wantsNumber ? formatNumber(value, spec, ctx) : { text: String(value) };
  }
  if (typeof value === 'boolean') return { text: String(value) };
  return { text: '' };
}
