import { PASS_SAVE_SOURCE, PASS_SW_SOURCE } from '../../../shared/pass-offline.ts';
import { createRouter } from '../../platform/openapi.ts';

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
