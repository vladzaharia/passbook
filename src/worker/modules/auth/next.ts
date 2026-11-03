import { homeFor, safeNextPath } from '../../../shared/next.ts';

export { homeFor };

/** Same-origin relative path or null. */
export const safeNext = safeNextPath;

/** The sign-in page, carrying a safe next (and any other query first). */
export function loginPath(next: string | null | undefined, query = ''): string {
  const safe = safeNext(next);
  const params = [query, safe ? `next=${encodeURIComponent(safe)}` : ''].filter(Boolean);
  return params.length ? `/login?${params.join('&')}` : '/login';
}
