import { PublicAssetParamSchema, PublicTokenParamSchema } from '../../../shared/contracts/index.ts';
import { createRouter, stub } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';

/** /p: bearer-link pass page and download. No sign-in. */
export const publicRoutes = createRouter();
publicRoutes.use('*', rateLimit('RL_PUBLIC'));
stub(publicRoutes, 'public', {
  method: 'get',
  path: '/{token}',
  summary: 'Pass page (server-rendered HTML)',
  params: PublicTokenParamSchema,
});
stub(publicRoutes, 'public', {
  method: 'get',
  path: '/{token}/pass.pkpass',
  summary: 'Download the pass',
  params: PublicTokenParamSchema,
});
stub(publicRoutes, 'public', {
  method: 'get',
  path: '/{token}/assets/{name}',
  summary: 'Pass image',
  params: PublicAssetParamSchema,
});
