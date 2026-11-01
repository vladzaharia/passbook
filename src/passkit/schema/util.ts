import type { PassIdentity, PassJson } from '../types.ts';
import type { StyleTag } from './constants.ts';

export type Report = (code: string, message: string, path?: string) => void;

export interface ValidationContext {
  pass: PassJson;
  identity: PassIdentity;
  error: Report;
  warn: Report;
  /** Advice that needs no action; falls back to warn where absent. */
  info?: Report;
  /** Style dictionaries present plus PET / SBP when their scheme is active. */
  styles: ReadonlySet<StyleTag>;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
export function isRgb(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = COLOR.exec(value);
  return !!m && [m[1], m[2], m[3]].every((n) => Number(n) <= 255);
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;

/** ISO 8601 with hours, minutes and a zone. Returns epoch ms, or undefined when invalid. */
export function parseIsoDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const m = ISO_DATE.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = Number(m[6] ?? 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isUint16(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535;
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

const NON_URL = new Set([
  'contactVenueEmail',
  'contactVenuePhoneNumber',
  'transitProviderEmail',
  'transitProviderPhoneNumber',
  'businessChatIdentifier',
]);

/** URL-valued keys: must parse, and should be https. Contact keys hold an email or phone number. */
export function checkUrlValue(
  ctx: ValidationContext,
  key: string,
  value: unknown,
  path: string,
): void {
  if (typeof value !== 'string' || value === '') {
    ctx.error('URL', `${key} must be a non-empty string.`, path);
    return;
  }
  if (NON_URL.has(key)) return;
  const url = parseUrl(value);
  if (!url) {
    ctx.error('URL', `${key} must be a valid URL.`, path);
    return;
  }
  if (!['https:', 'tel:', 'mailto:'].includes(url.protocol))
    ctx.warn('URL_SCHEME', `${key} should use https.`, path);
}

export function hasStyle(ctx: ValidationContext, ...tags: StyleTag[]): boolean {
  return tags.some((tag) => ctx.styles.has(tag));
}
