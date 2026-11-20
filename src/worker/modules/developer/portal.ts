/**
 * The developer portal on the main Worker: prerendered files from ASSETS (tools/build-developers.ts
 * writes them and a manifest), served under the app's host policy and a portal-only CSP. Only what
 * the manifest lists is served; the asset layer's SPA fallback never answers for a portal URL.
 */
import { Hono } from 'hono';
import { SearchMissSchema } from '../../../shared/contracts/developer.ts';
import { DEVELOPERS_INDEXABLE, PATHS } from '../../../shared/developers.ts';
import { missTerm } from '../../../shared/developers-search.ts';
import type { AppBindings } from '../../platform/context.ts';
import { notFoundHandler } from '../../platform/error-handler.ts';
import { clientRatePrefix } from '../../platform/rate-limit.ts';
import { developersContentSecurityPolicy } from '../../platform/security-headers.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { asBrowserPage } from '../../ssr/error-response.ts';
import { publicStatus } from '../status/public.ts';
import { cachedPublic } from '../status/public-cache.ts';
import { statusHtml } from '../status/public-page.tsx';

type Manifest = Record<string, { asset: string; type: string }>;

/** One read per isolate and asset binding; a missing manifest (a build without the portal) is an empty one. */
const manifests = new WeakMap<object, Promise<Manifest>>();

async function manifestOf(assets: Fetcher, origin: string): Promise<Manifest> {
  const res = await assets.fetch(new Request(new URL('/developers/manifest.json', origin)));
  const type = res.headers.get('content-type') ?? '';
  return res.ok && type.includes('json') ? ((await res.json()) as Manifest) : {};
}

export const developerPortalRoutes = new Hono<AppBindings>();

const MISS_WINDOW_MS = 60_000;
/** Terms accepted per network prefix per minute; a count in this isolate, which is enough to keep one reader from flooding the log. */
const MISS_PER_MINUTE = 20;
const missCounts = new Map<string, { window: number; n: number }>();

/**
 * A search that found nothing: the term, for the docs backlog. Takes no cookie's worth of identity
 * (the browser sends none) and logs nothing but the term, and only if it is plain words: a key,
 * token, id, address or link is dropped here even if a client sent it.
 */
developerPortalRoutes.post('/search-miss', async (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.body(null, 403);
  const window = Math.floor(c.var.clock.now() / MISS_WINDOW_MS);
  const key = clientRatePrefix(c);
  const seen = missCounts.get(key);
  const n = seen?.window === window ? seen.n + 1 : 1;
  if (missCounts.size > 5000) missCounts.clear();
  missCounts.set(key, { window, n });
  if (n > MISS_PER_MINUTE) return c.body(null, 429);
  const text = await c.req.text();
  const body = text.length <= 1024 ? parseMiss(text) : null;
  if (!body) return c.body(null, 400);
  const term = missTerm(body.term);
  if (term) c.var.log.info('developers.search_miss', { term });
  return c.body(null, 204);
});

function parseMiss(text: string) {
  try {
    const parsed = SearchMissSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    // Not JSON: the caller gets a 400.
    return null;
  }
}

developerPortalRoutes.get('/*', async (c) => {
  const url = new URL(c.req.url);
  const key = url.pathname.replace(/\/+$/, '') || '/developers';
  // Public status as data: the same allowlisted read as the page, from the cache for 30 seconds.
  if (key === PATHS.statusJson)
    return cachedPublic(c, async () => {
      const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' };
      try {
        return new Response(JSON.stringify(await publicStatus(serviceContext(c))), { headers });
      } catch (error) {
        c.var.log.warn('status.public_failed', { code: 'STATUS_PUBLIC_FAILED', error });
        return Response.json({ error: 'unavailable' }, { status: 503, headers });
      }
    });
  let manifest = manifests.get(c.env.ASSETS);
  if (!manifest) {
    manifest = manifestOf(c.env.ASSETS, url.origin);
    manifests.set(c.env.ASSETS, manifest);
  }
  const entry = Object.hasOwn(await manifest, key) ? (await manifest)[key] : undefined;
  const res = entry
    ? await c.env.ASSETS.fetch(new Request(new URL(entry.asset, url.origin)))
    : null;
  if (!entry || !res?.ok) return asBrowserPage(c, notFoundHandler(c));
  const headers = new Headers({
    'content-type': entry.type,
    'cache-control': 'public, max-age=300',
    'x-robots-tag': DEVELOPERS_INDEXABLE ? 'index, follow' : 'noindex, nofollow',
  });
  const etag = res.headers.get('etag');
  if (etag) headers.set('etag', etag);
  if (entry.type.startsWith('text/html')) {
    headers.set(
      'content-security-policy',
      developersContentSecurityPolicy({ turnstile: key === PATHS.console }),
    );
  }
  if (key === PATHS.status) {
    headers.set('cache-control', 'public, max-age=30');
    headers.delete('etag');
    const shell = await res.text();
    return cachedPublic(
      c,
      async () => new Response(await statusHtml(serviceContext(c), shell), { headers }),
    );
  }
  return new Response(c.req.method === 'HEAD' ? null : res.body, { headers });
});
