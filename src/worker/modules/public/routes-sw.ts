import { PASS_SAVE_SOURCE, PASS_SW_SOURCE } from '../../../shared/pass-offline.ts';
import { createRouter } from '../../platform/openapi.ts';
import { isTokenShape } from './service.ts';

const SCRIPT_HEADERS = {
  'content-type': 'text/javascript; charset=utf-8',
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
};

/**
 * The door view's offline worker, scope-limited by its registration to one token's page, and the
 * save controls that register it. Both are static: no token, no pass data.
 */
export const swRoutes = createRouter();
swRoutes.get('/sw.js', () => new Response(PASS_SW_SOURCE, { headers: SCRIPT_HEADERS }));
swRoutes.get('/save.js', () => new Response(PASS_SAVE_SOURCE, { headers: SCRIPT_HEADERS }));

// The saved door view's relative "back" link (./, so its HTML holds no token) lands here.
swRoutes.get('/:token/', (c) => {
  const token = c.req.param('token');
  return isTokenShape(token) ? c.redirect(`/p/${token}`, 308) : c.text('Not found', 404);
});
