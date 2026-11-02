import { safeNextPath } from '../../shared/next.ts';

/** Same-origin path only; anything else becomes the fallback. */
export const safeNext = (next: string | null | undefined, fallback = '/'): string =>
  safeNextPath(next) ?? fallback;

export function loginHref(next: string): string {
  return `/login?next=${encodeURIComponent(safeNext(next))}`;
}
