import { createMiddleware } from 'hono/factory';
import { MARKETING_POLICY } from '../../shared/marketing.ts';
import { SAVE_POLICY } from '../../shared/pass-offline.ts';
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

/** /scan reads the camera. Everything else keeps camera=(). */
export const SCAN_PERMISSIONS_POLICY =
  'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=(self)';
/** The barcode decoder worker (/assets/decode-worker-*): its script's policy governs the worker. */
export const DECODE_WORKER_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";

/** /scan: the SPA policy, plus wasm for zxing and a same-origin decoder worker. */
export function scanContentSecurityPolicy(): string {
  return contentSecurityPolicy(undefined, { scan: true });
}

/**
 * /developers: prerendered pages and one same-origin script, so no inline script or style and no
 * nonce. Trusted Types closes the DOM's HTML sinks; the portal's own code uses text only. The
 * console page alone admits the Turnstile widget, for "Create sandbox".
 */
export function developersContentSecurityPolicy(options: { turnstile?: boolean } = {}): string {
  const turnstile = options.turnstile ? ` ${TURNSTILE_ORIGIN}` : '';
  return [
    "default-src 'none'",
    `script-src 'self'${turnstile}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    options.turnstile ? `frame-src ${TURNSTILE_ORIGIN}` : "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    // The one policy the console page makes, for the Turnstile script address; no other page may make any.
    options.turnstile ? `trusted-types ${TURNSTILE_POLICY}` : "trusted-types 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * The public site (/, /door, /blueprints, /build, /access): static pages, one same-origin script and
 * one stylesheet each, no nonce. Style attributes stay (the kit sets custom properties inline);
 * scripts never. Trusted Types admits the one pass-through policy the pages' own HTML builders use.
 */
export function marketingContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    `trusted-types ${MARKETING_POLICY}`,
    'upgrade-insecure-requests',
  ].join('; ');
}

/** The Turnstile widget (join page only): its script and its challenge frame. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
/** The Trusted Types policy the widget loaders create (src/web/lib/turnstile-script.ts, public/join.js). */
export const TURNSTILE_POLICY = 'passbook-turnstile';
/** The policy for a same-origin worker script address (src/web/lib/trusted-worker-url.ts: the scanner). */
export const WORKER_POLICY = 'passbook-worker';

/**
 * Trusted Types: script may not reach a DOM sink with a string. Each page makes only the policies it
 * needs; the Turnstile loader, and the worker script address of /scan, and `passbook-save` (admits only /p/sw.js) for
 * save to this phone on /p and /b and in the app.
 */
function trustedTypesPolicy(names: string[]): string {
  return `trusted-types ${names.length ? names.join(' ') : "'none'"}`;
}

export function contentSecurityPolicy(
  nonce?: string,
  options: { scan?: boolean; turnstile?: boolean; offline?: boolean } = {},
): string {
  const n = nonce ? ` 'nonce-${nonce}'` : '';
  const wasm = options.scan ? " 'wasm-unsafe-eval'" : '';
  const turnstile = options.turnstile ? ` ${TURNSTILE_ORIGIN}` : '';
  return [
    "default-src 'none'",
    `script-src 'self'${wasm}${n}${turnstile}`,
    ...(options.scan ? ["worker-src 'self'"] : []),
    `style-src 'self'${n}`,
    // SSR pass cards set arbitrary pass colors through style attributes. Never scripts.
    ...(nonce ? ["style-src-attr 'unsafe-inline'"] : []),
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `frame-src 'self'${turnstile}`,
    "connect-src 'self'",
    "manifest-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    trustedTypesPolicy([
      ...(options.turnstile ? [TURNSTILE_POLICY] : []),
      ...(options.scan ? [WORKER_POLICY] : []),
      ...(options.offline ? [SAVE_POLICY] : []),
    ]),
    'upgrade-insecure-requests',
  ].join('; ');
}

const NO_REFERRER_PREFIXES = ['/p/', '/b/', '/d/', '/auth/', '/scan'];
/**
 * The join page's form posts to itself. A browser sends `Origin: null` on a POST from a
 * `no-referrer` page, which the join origin check refuses. `strict-origin` keeps the token in the
 * URL path out of every Referer, our own server's included, and lets the POST carry its origin.
 */
export const REFERRER_ORIGIN_ONLY = 'strict-origin';
const ORIGIN_ONLY_PREFIXES = ['/j/'];
const TURNSTILE_PREFIXES = ['/j/'];
/** Pass and bundle pages: the barcode page registers a worker to save the pass for offline. */
const OFFLINE_PREFIXES = ['/p/', '/b/'];
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
  set(
    'content-security-policy',
    contentSecurityPolicy(c.var.nonce, {
      turnstile: TURNSTILE_PREFIXES.some((p) => path.startsWith(p)),
      offline: OFFLINE_PREFIXES.some((p) => path.startsWith(p)),
    }),
  );
  set('strict-transport-security', HSTS);
  set('x-content-type-options', 'nosniff');
  set(
    'referrer-policy',
    ORIGIN_ONLY_PREFIXES.some((p) => path.startsWith(p))
      ? REFERRER_ORIGIN_ONLY
      : NO_REFERRER_PREFIXES.some((p) => path.startsWith(p))
        ? 'no-referrer'
        : REFERRER_DEFAULT,
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
