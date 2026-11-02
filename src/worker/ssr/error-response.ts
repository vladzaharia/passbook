import type { Context } from 'hono';
import type { AppBindings } from '../platform/context.ts';
import { renderErrorPage } from './error-page.tsx';
import { renderNotFoundPage } from './pass-page.tsx';

/** Machine routes keep problem+json whatever the client accepts. */
const MACHINE = /^\/(?:api|hooks|wallet)(?:\/|$)/;
const PAGED = (status: number) => status === 404 || status === 429 || status >= 500;
const PASS_LINK = /^\/p\/[^/]+(?:\/pass\.pkpass)?$/;

/** A browser navigation: GET or HEAD that prefers HTML, outside the API, hooks and Apple routes. */
export function wantsHtml(c: Context<AppBindings>): boolean {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return false;
  if (MACHINE.test(c.req.path)) return false;
  return (c.req.header('accept') ?? '').includes('text/html');
}

function retryAfterOf(res: Response): number | null {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Swaps a problem+json response for the hosted HTML page when a browser asked for the route.
 * Status and Retry-After carry over; a dead pass link gets the "Link expired" card.
 */
export function asBrowserPage(c: Context<AppBindings>, res: Response): Response {
  if (!wantsHtml(c) || !PAGED(res.status)) return res;
  if (!(res.headers.get('content-type') ?? '').startsWith('application/problem+json')) return res;
  const nonce = c.var.nonce;
  const html =
    res.status === 404 && PASS_LINK.test(c.req.path)
      ? renderNotFoundPage(nonce)
      : renderErrorPage({ status: res.status, nonce, retryAfter: retryAfterOf(res) });
  const headers = new Headers(res.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(c.req.method === 'HEAD' ? null : html, { status: res.status, headers });
}
