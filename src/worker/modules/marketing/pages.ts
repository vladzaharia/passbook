import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { MARKETING_ASSETS, MARKETING_PATHS } from '../../../shared/marketing.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { marketingContentSecurityPolicy, staticAsset } from '../../platform/security-headers.ts';

type Ctx = Context<AppBindings>;
type Address = keyof typeof MARKETING_ASSETS;

/** The built page for an address, or null when the build has none. */
async function builtPage(c: Ctx, address: Address): Promise<Response | null> {
  const asset = new URL(MARKETING_ASSETS[address], c.req.url);
  const res = await c.env.ASSETS.fetch(new Request(asset));
  const html = (res.headers.get('content-type') ?? '').startsWith('text/html');
  return res.ok && html ? res : null;
}

function pageResponse(c: Ctx, res: Response, headers: Record<string, string>): Response {
  const out = new Response(c.req.method === 'HEAD' ? null : res.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': marketingContentSecurityPolicy(),
      // The edge must not inject Cloudflare's analytics beacon, which the CSP refuses.
      'x-robots-tag': 'index, follow',
      ...headers,
    },
  });
  const etag = res.headers.get('etag');
  if (etag && headers['cache-control']?.startsWith('public')) out.headers.set('etag', etag);
  return out;
}

const notBuilt = (c: Ctx) => c.notFound();

/** /door, /blueprints, /build and /access: public, cached for five minutes. */
export async function marketingPage(c: Ctx, address: Address): Promise<Response> {
  const res = await builtPage(c, address);
  if (!res) return notBuilt(c);
  return pageResponse(c, res, { 'cache-control': 'public, max-age=300, no-transform' });
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
  const res = await builtPage(c, MARKETING_PATHS.home);
  if (!res) return notBuilt(c);
  return pageResponse(c, res, headers);
}

/**
 * `/access/sent`: the request page after a send, for a form post without script. The same asset
 * with the form hidden, the done panel shown, the ticket marked sent and the Buddy tucking a pass.
 */
export async function accessSentPage(c: Ctx): Promise<Response> {
  const res = await builtPage(c, MARKETING_PATHS.access);
  if (!res) return notBuilt(c);
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
    .transform(res);
  return pageResponse(c, rewritten, {
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  });
}
