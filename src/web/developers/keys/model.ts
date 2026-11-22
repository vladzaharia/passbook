import type { DeveloperHomeKey } from '../../../shared/contracts/developer-home.ts';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import { presetOf } from '../../../shared/developers-keys.ts';
import { ago } from '../workbench/model.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Dec 21`; the year only when it is not this one. */
export function day(at: number, now: number): string {
  const d = new Date(at);
  const same = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${same ? '' : `, ${d.getUTCFullYear()}`}`;
}

export const expiryOf = (k: Pick<DeveloperHomeKey, 'expiresAt'>, now: number): string =>
  k.expiresAt === null ? KEYS_COPY.never : day(k.expiresAt, now);

/** The preset the key's scopes equal, else how many scopes it holds. */
export const accessOf = (k: Pick<DeveloperHomeKey, 'scopes'>): string =>
  presetOf(k.scopes) ?? `${k.scopes.length} ${k.scopes.length === 1 ? 'scope' : 'scopes'}`;

/** What the page draws of a secret once it hides it: its start and last four, never the middle. */
export const maskSecret = (secret: string): string =>
  `${secret.slice(0, secret.indexOf('_', 5) + 1 || 9)}…${secret.slice(-4)}`;

/** `HH:MM` on the viewer's clock, for "The old key stops 14:05". */
export const clock = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** `2 min ago`, `now`, or Never. */
export function usedOf(k: Pick<DeveloperHomeKey, 'lastUsedAt'>, now: number): string {
  if (k.lastUsedAt === null) return KEYS_COPY.never;
  const t = ago(k.lastUsedAt, now);
  return t === 'now' ? t : `${t} ago`;
}
