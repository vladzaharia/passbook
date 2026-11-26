import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { matchedRoutes } from 'hono/route';
import { MODE_HEADER } from '../../shared/contracts/common.ts';
import { ForbiddenError } from './errors.ts';
import { createLogger } from './log.ts';

/** A developer try token (modules/developer/try-token.ts): the one bearer a browser may send. */
export const TRY_TOKEN_PREFIX = 'pbtry_';

/**
 * KEY_IN_BROWSER rollout. A key made before the cutoff (the PX8 release; move it if the release moves) is only
 * reported until the cutoff plus 30 days: the call goes through with a `PassBook-Warning` header and a
 * `KEY_IN_BROWSER_SEEN` log. A key made from the cutoff on, and every key after the window, is refused.
 */
export const KEY_IN_BROWSER_CUTOFF = Date.UTC(2026, 11, 1);
export const KEY_IN_BROWSER_REPORT_MS = 30 * 86_400_000;
export const KEY_IN_BROWSER_WARNING_HEADER = 'PassBook-Warning';

const ENFORCED_FROM = new Date(KEY_IN_BROWSER_CUTOFF + KEY_IN_BROWSER_REPORT_MS)
  .toISOString()
  .slice(0, 10);
const WARNING = `KEY_IN_BROWSER: this API key was sent with browser headers (Origin, Sec-Fetch-Site or a PassBook cookie) and is refused from ${ENFORCED_FROM}. When you proxy browser requests, strip Origin, Sec-Fetch-* and Cookie.`;

/** Our own cookies (`__Host-wallet_sid`, `__Host-wallet_scan`): only a browser that signed in holds one. */
const OWN_COOKIE = /(?:^|;)\s*__Host-wallet_/;

/** Where a key call came from: the address for the key's IP list, and the browser signals it carried. */
export interface KeyCaller {
  ip: string | undefined;
  /** The request carries a browser signal (`hasBrowserSignals`). */
  browser?: boolean;
  /** The session cookie sent with the request: a try token works only beside the session it was made for. */
  sessionCookie?: string;
  /** Sets the report-only warning header on the response. */
  warn?: (text: string) => void;
  /** The request's `X-PassBook-Mode`, trimmed and lowercased: a Workbench token refuses `live`. */
  mode?: string;
  /** Every method route the request matched, as `GET /api/v1/passes/:id`: the Workbench allowlist reads them. */
  routes?: readonly string[];
}

/** The method routes a request matched (middleware registered with `use` excluded), as `METHOD /path`. */
export function routeKeysOf(c: Context): string[] {
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
  const keys = matchedRoutes(c)
    .filter((r) => r.method === method)
    .map((r) => `${method} ${r.path}`);
  return [...new Set(keys)];
}

/**
 * True when the request comes from a browser. `Sec-Fetch-Site` is sent by every current browser on every request
 * and page script can neither drop nor fake it; `Origin` covers older browsers on cross-origin and non-GET calls;
 * our cookies mean a signed-in browser. Not signals: `Sec-Fetch-Mode` (Node's fetch sends it), `User-Agent`,
 * `Referer`, and other cookies (cookie-jar clients echo Cloudflare's). A proxy must not forward these headers.
 */
export function hasBrowserSignals(headers: Headers): boolean {
  return (
    headers.has('sec-fetch-site') ||
    headers.has('origin') ||
    OWN_COOKIE.test(headers.get('cookie') ?? '')
  );
}

/** The caller of a key guard; `sessionCookieName` comes from auth.ts. */
export function keyCallerOf(c: Context, sessionCookieName: string): KeyCaller {
  return {
    ip: c.req.header('cf-connecting-ip'),
    browser: hasBrowserSignals(c.req.raw.headers),
    sessionCookie: getCookie(c, sessionCookieName),
    warn: (text) => c.header(KEY_IN_BROWSER_WARNING_HEADER, text),
    mode: c.req.header(MODE_HEADER)?.trim().toLowerCase(),
    routes: routeKeysOf(c),
  };
}

/** How a key sent from a browser is treated: reported while it predates the cutoff and the window is open. */
export function keyInBrowserMode(createdAt: number | null, now: number): 'report' | 'enforce' {
  const window = now < KEY_IN_BROWSER_CUTOFF + KEY_IN_BROWSER_REPORT_MS;
  return createdAt !== null && createdAt < KEY_IN_BROWSER_CUTOFF && window ? 'report' : 'enforce';
}

/** 403 `KEY_IN_BROWSER`, logged with the key's org and prefix when known, never the secret. */
export function keyInBrowserRefusal(key: { orgId: string | null; prefix: string } | null) {
  createLogger().warn('auth.key_in_browser', {
    code: 'KEY_IN_BROWSER',
    orgId: key?.orgId ?? null,
    keyPrefix: key?.prefix ?? null,
  });
  return new ForbiddenError(
    'API keys do not work in a browser. Call the API from your server, or use Try it in the developer portal.',
    'KEY_IN_BROWSER',
  );
}

/** Report-only: the call goes through, logged as `KEY_IN_BROWSER_SEEN` and answered with the warning header. */
export function reportKeyInBrowser(
  caller: KeyCaller | undefined,
  key: { orgId: string | null; prefix: string },
): void {
  createLogger().warn('auth.key_in_browser_seen', {
    code: 'KEY_IN_BROWSER_SEEN',
    orgId: key.orgId,
    keyPrefix: key.prefix,
  });
  caller?.warn?.(WARNING);
}
