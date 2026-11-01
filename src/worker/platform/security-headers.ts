import { createMiddleware } from 'hono/factory';
import type { AppBindings } from './context.ts';

/** Shared with public/_headers; security-headers.test.ts fails when the two drift. */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';
export const HSTS = 'max-age=31536000; includeSubDomains';
export const REFERRER_DEFAULT = 'strict-origin-when-cross-origin';
export const COOP = 'same-origin';
export const CORP = 'same-origin';
export const XFO = 'DENY';

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

/** Applies the headers from the spec to every Worker response. Static assets use public/_headers. */
export const securityHeaders = createMiddleware<AppBindings>(async (c, next) => {
  await next();
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
  if (NO_STORE_PREFIXES.some((p) => path.startsWith(p)) || path.endsWith('/pass.pkpass')) {
    set('cache-control', 'no-store');
  }
});
