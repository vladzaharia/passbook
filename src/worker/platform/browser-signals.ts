import type { Context } from 'hono';
import { ForbiddenError } from './errors.ts';
import { createLogger } from './log.ts';

/** A developer try token (modules/developer/try-token.ts): the one bearer a browser may send. */
export const TRY_TOKEN_PREFIX = 'pbtry_';

/** Our own cookies (`__Host-wallet_sid`, `__Host-wallet_scan`): only a browser that signed in holds one. */
const OWN_COOKIE = /(?:^|;)\s*__Host-wallet_/;

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

/**
 * 403 `KEY_IN_BROWSER` for a bearer other than a try token sent from a browser, before the key is looked up: a
 * key secret never works in a browser console, live or test.
 */
export function refuseKeyInBrowser(c: Context): void {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (bearer?.startsWith(TRY_TOKEN_PREFIX) || !hasBrowserSignals(c.req.raw.headers)) return;
  createLogger().warn('auth.key_in_browser', { code: 'KEY_IN_BROWSER' });
  throw new ForbiddenError(
    'API keys do not work in a browser. Call the API from your server, or use Try it in the developer portal.',
    'KEY_IN_BROWSER',
  );
}
