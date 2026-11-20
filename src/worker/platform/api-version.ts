import type { Context } from 'hono';
import versions from '../../../docs/api/versions.json' with { type: 'json' };
import { ValidationError } from './errors-core.ts';

/** The dated versions in docs/api/versions.json, oldest first. */
export const API_VERSIONS: readonly string[] = versions.versions.map((v) => v.date).sort();

/**
 * The `PassBook-Version` a request pins, or null for none (the behaviour before the first dated
 * version). A date that is not listed is refused, so a typo never silently picks the old behaviour.
 */
export function pinnedVersion(c: Context): string | null {
  const raw = c.req.header('passbook-version')?.trim();
  if (!raw) return null;
  if (!API_VERSIONS.includes(raw))
    throw new ValidationError(
      `Unknown PassBook-Version. Use one of: ${API_VERSIONS.join(', ')}.`,
      [],
      'API_VERSION_UNKNOWN',
    );
  return raw;
}

/** True when the request pins `date` or a later version. */
export const atLeast = (c: Context, date: string): boolean => {
  const pinned = pinnedVersion(c);
  return pinned !== null && pinned >= date;
};
