/**
 * The developer portal on the main Worker: prerendered files from ASSETS (tools/build-developers.ts
 * writes them and a manifest), served under the app's host policy and a portal-only CSP. Only what
 * the manifest lists is served; the asset layer's SPA fallback never answers for a portal URL.
 */
import { Hono } from 'hono';
import { DEVELOPERS_INDEXABLE, PATHS } from '../../../shared/developers.ts';
import type { AppBindings } from '../../platform/context.ts';
import { notFoundHandler } from '../../platform/error-handler.ts';
import { developersContentSecurityPolicy } from '../../platform/security-headers.ts';
import { asBrowserPage } from '../../ssr/error-response.ts';

type Manifest = Record<string, { asset: string; type: string }>;

/** One read per isolate and asset binding; a missing manifest (a build without the portal) is an empty one. */
const manifests = new WeakMap<object, Promise<Manifest>>();

async function manifestOf(assets: Fetcher, origin: string): Promise<Manifest> {
  const res = await assets.fetch(new Request(new URL('/developers/manifest.json', origin)));
  const type = res.headers.get('content-type') ?? '';
  return res.ok && type.includes('json') ? ((await res.json()) as Manifest) : {};
}

export const developerPortalRoutes = new Hono<AppBindings>();

developerPortalRoutes.get('/*', async (c) => {
  const url = new URL(c.req.url);
  const key = url.pathname.replace(/\/+$/, '') || '/developers';
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
  return new Response(c.req.method === 'HEAD' ? null : res.body, { headers });
});
