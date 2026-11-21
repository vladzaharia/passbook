import { BUNDLE_SW_SOURCE } from '../../../shared/pass-offline.ts';
import { createRouter } from '../../platform/openapi.ts';

/** A bundle member's door-view worker; each registration's scope is one member's barcode path. */
export const bundleSwRoutes = createRouter();
bundleSwRoutes.get(
  '/sw.js',
  () =>
    new Response(BUNDLE_SW_SOURCE, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      },
    }),
);
