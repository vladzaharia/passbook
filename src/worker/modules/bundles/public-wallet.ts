import { z } from 'zod';
import { PublicBundleParamSchema } from '../../../shared/contracts/bundles.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { svc } from '../passes/http.ts';
import { bundleForToken } from './public-service.ts';
import { bundleGoogleLocation } from './wallet-links.ts';

/** GET /b/:token/wallet/google: every Google-offered member in one save link (`?part=` past eight). */
export function registerBundleGoogleRoute(router: ReturnType<typeof createRouter>) {
  router.use('/:token/wallet/google', rateLimit('RL_PUBLIC'));
  register(
    router,
    'public',
    {
      method: 'get',
      path: '/{token}/wallet/google',
      summary: 'Add the bundle to Google Wallet with one save link',
      params: PublicBundleParamSchema,
      query: z.object({ part: z.coerce.number().int().min(0).max(31).default(0) }),
      status: 302,
    },
    async (c) => {
      const { token } = c.req.valid('param');
      const { part } = c.req.valid('query');
      const bundle = await bundleForToken(svc(c), token);
      const location = await bundleGoogleLocation(svc(c), bundle, part);
      return new Response(null, {
        status: 302,
        headers: {
          'cache-control': 'private, no-store',
          'referrer-policy': 'no-referrer',
          'x-robots-tag': 'noindex, nofollow',
          location,
        },
      });
    },
  );
}
