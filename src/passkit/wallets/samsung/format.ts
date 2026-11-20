/** Value to text helpers: Samsung attributes are strings, dates are epoch milliseconds. */
import type { RoleValue } from '../types.ts';
import { formatWhen } from '../when.ts';

export function epochMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

export const epochText = (iso: string | undefined): string | undefined => {
  const ms = epochMs(iso);
  return ms === undefined ? undefined : String(ms);
};

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
