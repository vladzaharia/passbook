import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { MARKETING_ASSETS, MARKETING_PATHS } from '../../../shared/marketing.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { notFoundHandler } from '../../platform/error-handler.ts';
import { marketingContentSecurityPolicy, staticAsset } from '../../platform/security-headers.ts';
import { asBrowserPage } from '../../ssr/error-response.ts';

type Ctx = Context<AppBindings>;
type Address = keyof typeof MARKETING_ASSETS;

/** Every built page loads its hashed entry from here; the app's shell never does. */
const BUILT_MARK = '/assets/marketing-';

/**
 * The built page for an address, or null when the build has none. A missing file would come back
 * as the app's shell (the asset layer's SPA fallback), which must not be served as a site page.
 */
async function builtPage(
  c: Ctx,
  address: Address,
): Promise<{ html: string; etag: string | null } | null> {
  const asset = new URL(MARKETING_ASSETS[address], c.req.url);
  const res = await c.env.ASSETS.fetch(new Request(asset));
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('text/html')) return null;
  const html = await res.text();
  return html.includes(BUILT_MARK) ? { html, etag: res.headers.get('etag') } : null;
}

function pageResponse(
  c: Ctx,
  page: { html: string | ReadableStream; etag: string | null },
  headers: Record<string, string>,
): Response {
  const out = new Response(c.req.method === 'HEAD' ? null : page.html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': marketingContentSecurityPolicy(),
      // The edge must not inject Cloudflare's analytics beacon, which the CSP refuses.
      'x-robots-tag': 'index, follow',
      ...headers,
    },
  });
  if (page.etag && headers['cache-control']?.startsWith('public'))
    out.headers.set('etag', page.etag);
  return out;
}

/** A page the build lacks is a 404, never the app shell the asset layer falls back to. */
const notBuilt = async (c: Ctx) => asBrowserPage(c, notFoundHandler(c));

/** /door, /blueprints, /build and /access: public, cached for five minutes. */
export async function marketingPage(c: Ctx, address: Address): Promise<Response> {
  const page = await builtPage(c, address);
  if (!page) return await notBuilt(c);
  return pageResponse(c, page, { 'cache-control': 'public, max-age=300, no-transform' });
}

/**
 * `/`: Home for a visitor with no session cookie, the app's shell for one with a cookie (a stale
 * cookie gets the shell, whose root guard sends it to /login). Presence only, no session read.
 */
export async function homePage(c: Ctx): Promise<Response> {
  const headers = { 'cache-control': 'private, no-cache', vary: 'Cookie' };
  if (getCookie(c, SESSION_COOKIE)) {
    const shell = await c.env.ASSETS.fetch(c.req.raw);
    const out = new Response(c.req.method === 'HEAD' ? null : shell.body, shell);
    for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
    return staticAsset(out);
  }
  const page = await builtPage(c, MARKETING_PATHS.home);
  if (!page) return await notBuilt(c);
  return pageResponse(c, page, headers);
}

/**
 * `/access/sent`: the request page after a send, for a form post without script. The same asset
 * with the form hidden, the done panel shown, the ticket marked sent and the Buddy tucking a pass.
 */
export async function accessSentPage(c: Ctx): Promise<Response> {
  const page = await builtPage(c, MARKETING_PATHS.access);
  if (!page) return await notBuilt(c);
  const rewritten = new HTMLRewriter()
    .on('#acc-form', {
      element: (el) => {
        el.setAttribute('hidden', '');
      },
    })
    .on('#acc-done', {
      element: (el) => {
        el.removeAttribute('hidden');
      },
    })
    .on('#acc-ticket', {
      element: (el) => {
        el.setAttribute('class', `${el.getAttribute('class') ?? ''} sent`.trim());
      },
    })
    .on('#acc-buddy', {
      element: (el) => {
        el.setAttribute('data-buddy', 'tuck');
      },
    })
    .transform(new Response(page.html));
  return pageResponse(
    c,
    { html: rewritten.body ?? '', etag: null },
    {
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  );
}
