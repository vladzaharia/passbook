import { createMiddleware } from 'hono/factory';
import type { AppBindings } from './context.ts';

/** Shared with public/_headers; security-headers.test.ts fails when the two drift. */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
export const HSTS = 'max-age=31536000; includeSubDomains';
export const REFERRER_DEFAULT = 'strict-origin-when-cross-origin';
export const COOP = 'same-origin';
export const CORP = 'same-origin';
export const XFO = 'DENY';
/** Nothing the Worker answers is for search: pass and sign-in links, the API, Apple and hooks. */
export const ROBOTS = 'noindex, nofollow';

export function contentSecurityPolicy(nonce?: string): string {
  const n = nonce ? ` 'nonce-${nonce}'` : '';
  return [
    "default-src 'none'",
    `script-src 'self'${n}`,
    `style-src 'self'${n}`,
    // SSR pass cards set arbitrary pass colors through style attributes. Never scripts.
    ...(nonce ? ["style-src-attr 'unsafe-inline'"] : []),
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const NO_REFERRER_PREFIXES = ['/p/', '/auth/'];
const NO_STORE_PREFIXES = ['/api/', '/auth/'];

const passedThrough = new WeakSet<Response>();

/**
 * A static-asset response the Worker returns unchanged (the SPA's pages): public/_headers already
 * set its headers, and the sign-in page must stay indexable.
 */
export function staticAsset(res: Response): Response {
  passedThrough.add(res);
  return res;
}

/** Applies the headers from the spec to every Worker response. Static assets use public/_headers. */
export const securityHeaders = createMiddleware<AppBindings>(async (c, next) => {
  await next();
  if (passedThrough.has(c.res)) return;
  c.res = new Response(c.res.body, c.res);
  const path = new URL(c.req.url).pathname;
  const headers = c.res.headers;
  const set = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };
  set('content-security-policy', contentSecurityPolicy(c.var.nonce));
  set('strict-transport-security', HSTS);
  set('x-content-type-options', 'nosniff');
  set(
    'referrer-policy',
    NO_REFERRER_PREFIXES.some((p) => path.startsWith(p)) ? 'no-referrer' : REFERRER_DEFAULT,
  );
  set('permissions-policy', PERMISSIONS_POLICY);
  set('cross-origin-opener-policy', COOP);
  set('cross-origin-resource-policy', CORP);
  set('x-frame-options', XFO);
  // Hashed bundles are fetched to render the indexable sign-in page.
  if (!path.startsWith('/assets/')) set('x-robots-tag', ROBOTS);
  if (NO_STORE_PREFIXES.some((p) => path.startsWith(p)) || path.endsWith('/pass.pkpass')) {
    set('cache-control', 'no-store');
  }
});
