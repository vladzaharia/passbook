import { ValidationError } from '../../platform/errors.ts';
import { assertSafeUrl } from '../../platform/safe-fetch.ts';

/**
 * The static rules (https, port 443, no credentials, no IP literal, no platform host) plus a
 * canonical form. The caller still resolves the host at save time and `createSafeFetch` repeats
 * both checks on every attempt.
 */
export function normalizeEndpointUrl(raw: string, platformHosts: string[]): string {
  const url = assertSafeUrl(raw, platformHosts);
  // A root-dot host (`example.com.`) is refused outright, so no later comparison can be fooled by it.
  if (url.hostname.endsWith('.'))
    throw new ValidationError('The host is not allowed.', [], 'UNSAFE_URL');
  url.hash = '';
  return url.href;
}

/** Logs and audit carry the host only: the path is a bearer secret for catch-hook URLs. */
export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** What a reader sees: the host and the last four characters of the path. */
export function maskUrl(url: string): string {
  const { hostname, pathname } = new URL(url);
  const path = pathname === '/' ? '' : pathname.slice(-4);
  return path ? `${hostname}/…${path}` : hostname;
}
