import type { SafeFetch } from '../../platform/safe-fetch.ts';
import { type AnyConnector, ConnectorError } from '../types.ts';

/** A URL off the connector's declared origins: a permanent CONFIG error, never retried. */
export function offOrigin(): ConnectorError {
  return new ConnectorError('CONFIG', { permanent: true, reason: 'OFF_ORIGIN' });
}

function originOf(raw: string): string | null {
  if (!URL.canParse(raw)) return null;
  const { origin } = new URL(raw);
  // Opaque URLs (data:, blob:) all share the origin "null"; none is ever reachable.
  return origin === 'null' ? null : origin;
}

/**
 * Limits a fetch to exact origins (scheme, host and port, normalized). Any other URL is refused before
 * safe-fetch runs, so before DNS. `undefined` returns the fetch unchanged.
 */
export function pinFetch(fetch: SafeFetch, origins: readonly string[] | undefined): SafeFetch {
  if (origins === undefined) return fetch;
  const allowed = new Set(origins.map(originOf).filter((o) => o !== null));
  return (url, init) => {
    const origin = originOf(url);
    if (origin === null || !allowed.has(origin)) return Promise.reject(offOrigin());
    return fetch(url, init);
  };
}

/** The connector's fetch for this config: pinned to `def.egress(config)` when the connector declares it. */
export function egressFetch(def: AnyConnector, config: unknown, fetch: SafeFetch): SafeFetch {
  return pinFetch(fetch, def.egress?.(config));
}
