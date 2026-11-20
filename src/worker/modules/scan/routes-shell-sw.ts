import { SCAN_SW_SCOPE, scanSwSource } from '../../../shared/scan-sw.ts';
import { createRouter } from '../../platform/openapi.ts';

/** The scanner's shell worker: mounted at /scan (behind the scan gate), allowed to control /scan itself. */
export const scanShellSwRoutes = createRouter();
scanShellSwRoutes.get(
  '/sw.js',
  (c) =>
    new Response(scanSwSource(c.env.CF_VERSION?.id ?? 'dev'), {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'service-worker-allowed': SCAN_SW_SCOPE,
        'x-content-type-options': 'nosniff',
      },
    }),
);
