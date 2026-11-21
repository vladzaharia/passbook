import { BUNDLE_SAVE_SOURCE, BUNDLE_SW_SOURCE } from '../../../shared/pass-offline.ts';
import { createRouter } from '../../platform/openapi.ts';
import { isTokenShape } from '../public/service.ts';

const SCRIPT_HEADERS = {
  'content-type': 'text/javascript; charset=utf-8',
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
};

/**
 * A bundle member's door-view worker and the save controls that register it; each registration's
 * scope is one member's barcode path. Both are static: no token, no pass data.
 */
export const bundleSwRoutes = createRouter();
bundleSwRoutes.get('/sw.js', () => new Response(BUNDLE_SW_SOURCE, { headers: SCRIPT_HEADERS }));
bundleSwRoutes.get('/save.js', () => new Response(BUNDLE_SAVE_SOURCE, { headers: SCRIPT_HEADERS }));

// The saved door view's relative "back" link (./, so its HTML holds no token) lands here.
bundleSwRoutes.get('/:token/:passId/', (c) => {
  const { token, passId } = c.req.param();
  return isTokenShape(token) && /^[0-9a-f-]{36}$/.test(passId)
    ? c.redirect(`/b/${token}/${passId}`, 308)
    : c.text('Not found', 404);
});
