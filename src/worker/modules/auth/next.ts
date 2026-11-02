import { safeNextPath } from '../../../shared/next.ts';

/** Same-origin relative path or null. */
export const safeNext = safeNextPath;

export function nextOrHome(raw: string | null | undefined): string {
  return safeNext(raw) ?? '/';
}
