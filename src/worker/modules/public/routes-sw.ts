import { PASS_SW_SOURCE } from '../../../shared/pass-offline.ts';
import { createRouter } from '../../platform/openapi.ts';

/** The barcode page's offline worker, scope-limited by its registration to one token's page. */
export const swRoutes = createRouter();
swRoutes.get(
  '/sw.js',
  () =>
    new Response(PASS_SW_SOURCE, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    }),
);
