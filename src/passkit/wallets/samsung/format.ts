/** Value to text helpers: Samsung attributes are strings, dates are epoch milliseconds. */
import type { RoleValue } from '../types.ts';

export function epochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

export const epochText = (iso: string | undefined): string | undefined => {
  const ms = epochMs(iso);
  return ms === undefined ? undefined : String(ms);
};

const WHEN =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/u;
const NONE = 'PKDateStyleNone';

/**
 * A date or time as the pass's own wall clock, without locale or zone conversion:
 * `2030-06-01 19:00 -07:00`. Values that are not ISO dates come back unchanged.
 */
export function formatWhen(value: string, dateStyle?: string, timeStyle?: string): string {
  const m = WHEN.exec(value.trim());
  if (!m) return value;
  const both = dateStyle === undefined && timeStyle === undefined;
  const showDate = both || (dateStyle !== undefined && dateStyle !== NONE);
  const showTime = m[2] !== undefined && (both || (timeStyle !== undefined && timeStyle !== NONE));
  const zone = m[3] === 'Z' ? ' UTC' : m[3] ? ` ${m[3]}` : '';
  return [showDate ? m[1] : '', showTime ? m[2] : '', showTime ? zone.trim() : '']
    .filter(Boolean)
    .join(' ');
}

/** A resolved role as display text. Empty for kinds with no text form. */
export function roleText(role: RoleValue): string {
  switch (role.kind) {
    case 'text':
      return role.text;
    case 'number':
      return role.text;
    case 'date':
      return formatWhen(role.iso);
    case 'money':
      return `${role.amount} ${role.currencyCode}`;
    case 'url':
      return role.url;
    case 'channel':
    case 'location':
    case 'app':
    case 'links':
      return '';
  }
}
