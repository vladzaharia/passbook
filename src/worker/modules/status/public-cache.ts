import type { Context } from 'hono';
import type { AppBindings } from '../../platform/context.ts';

/**
 * The public status answers from Cloudflare's cache for 30 seconds, so a crowd on the page never runs the platform
 * probes more than once per colo per half minute. Only a 2xx answer is stored.
 */
export async function cachedPublic(
  c: Context<AppBindings>,
  build: () => Promise<Response>,
): Promise<Response> {
  const key = new Request(c.req.url, { method: 'GET' });
  const hit = await caches.default.match(key);
  const res = hit ?? (await build());
  if (!hit && res.ok) {
    const put = caches.default.put(key, res.clone());
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      // No execution context (tests): wait for it here.
      await put;
    }
  }
  return c.req.method === 'HEAD' ? new Response(null, res) : res;
}
