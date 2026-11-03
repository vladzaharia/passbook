import type { Context } from 'hono';
import type { AppBindings } from '../platform/context.ts';
import { renderErrorPage } from './error-page.tsx';
import { requestTheme } from './head.ts';
import { renderNotFoundPage } from './pass-page.tsx';

/** Machine routes keep problem+json whatever the client accepts. */
const MACHINE = /^\/(?:api|hooks|wallet)(?:\/|$)/;
const FORM = /^(?:application\/x-www-form-urlencoded|multipart\/form-data)/i;
const PASS_LINK = /^\/p\/[^/]+(?:\/pass\.pkpass)?$/;

const isNavigation = (c: Context<AppBindings>) => c.req.method === 'GET' || c.req.method === 'HEAD';

/**
 * A browser asking for a page, outside the API, hooks and Apple routes: a navigation (GET or
 * HEAD) that prefers HTML, or a form post (form body or `Accept: text/html`).
 */
export function wantsHtml(c: Context<AppBindings>): boolean {
  if (MACHINE.test(c.req.path)) return false;
  const html = (c.req.header('accept') ?? '').includes('text/html');
  if (isNavigation(c)) return html;
  return html || FORM.test(c.req.header('content-type') ?? '');
}

/** Navigations page only what a reload can fix; a form post pages every refusal. */
const paged = (c: Context<AppBindings>, status: number) =>
  isNavigation(c) ? status === 404 || status === 429 || status >= 500 : status >= 400;

function retryAfterOf(res: Response): number | null {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The problem's sentence for a 4xx refusal (5xx details stay generic). */
async function detailOf(res: Response): Promise<string | undefined> {
  if (res.status >= 500 || res.status === 404 || res.status === 429) return undefined;
  try {
    const body = (await res.clone().json()) as { detail?: unknown };
    return typeof body.detail === 'string' && body.detail ? body.detail : undefined;
  } catch {
    // Not JSON after all: the page keeps its default line.
    return undefined;
  }
}

/**
 * Swaps a problem+json response for the hosted HTML page when a browser asked for the route.
 * Status and Retry-After carry over; a dead pass link gets the "Link expired" card. A refused
 * form post cannot be retried by reloading, so its way back is the sign-in page or home.
 */
export async function asBrowserPage(c: Context<AppBindings>, res: Response): Promise<Response> {
  if (!wantsHtml(c) || !paged(c, res.status)) return res;
  if (!(res.headers.get('content-type') ?? '').startsWith('application/problem+json')) return res;
  const nonce = c.var.nonce;
  const theme = requestTheme(c);
  let html: string;
  if (res.status === 404 && PASS_LINK.test(c.req.path)) {
    html = renderNotFoundPage(nonce, theme);
  } else {
    const line = isNavigation(c) ? undefined : await detailOf(res);
    html = renderErrorPage({
      status: res.status,
      nonce,
      theme,
      retryAfter: retryAfterOf(res),
      ...(line ? { line } : {}),
      ...(isNavigation(c)
        ? {}
        : {
            action: c.req.path.startsWith('/auth/')
              ? { label: 'Back to sign in', href: '/login' }
              : { label: 'Go home', href: '/' },
          }),
    });
  }
  const headers = new Headers(res.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(c.req.method === 'HEAD' ? null : html, { status: res.status, headers });
}
