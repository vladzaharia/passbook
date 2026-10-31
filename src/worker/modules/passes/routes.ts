import { z } from 'zod';
import {
  BulkReissueResponseSchema,
  BulkReissueSchema,
  CreatePassSchema,
  DiffQuerySchema,
  IdParamSchema,
  OkSchema,
  PassActionResponseSchema,
  PassAssetListSchema,
  PassAssetParamSchema,
  PassAssetSchema,
  PassDetailSchema,
  PassListQuerySchema,
  PassListSchema,
  RefreshPassResponseSchema,
  ResendEmailSchema,
  RotateLinkResponseSchema,
  UpdatePassSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, requireAdmin, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const passesRoutes = createRouter();
guard(
  passesRoutes,
  requireApiKeyOrAdmin(methodScope({ read: 'passes:read', write: 'passes:write' })),
);

passesRoutes.use('/bulk-reissue', requireAdmin);
stub(passesRoutes, 'passes', {
  method: 'get',
  path: '/',
  summary: 'List passes',
  query: PassListQuerySchema,
  response: PassListSchema,
});
stub(passesRoutes, 'passes', {
  method: 'post',
  path: '/',
  summary: 'Create a pass (Idempotency-Key supported)',
  body: CreatePassSchema,
  status: 201,
  response: PassDetailSchema,
});
stub(passesRoutes, 'passes', {
  method: 'get',
  path: '/{id}',
  summary: 'Get a pass',
  params: IdParamSchema,
  response: PassDetailSchema,
});
stub(passesRoutes, 'passes', {
  method: 'patch',
  path: '/{id}',
  summary: 'Update a pass (If-Match: version)',
  params: IdParamSchema,
  body: UpdatePassSchema,
  response: PassDetailSchema,
});
stub(passesRoutes, 'passes', {
  method: 'delete',
  path: '/{id}',
  summary: 'Delete a pass',
  params: IdParamSchema,
  response: OkSchema,
});
stub(passesRoutes, 'passes', {
  method: 'post',
  path: '/{id}/void',
  summary: 'Void a pass',
  params: IdParamSchema,
  response: PassActionResponseSchema,
});
stub(passesRoutes, 'passes', {
  method: 'post',
  path: '/{id}/unvoid',
  summary: 'Unvoid a pass',
  params: IdParamSchema,
  response: PassActionResponseSchema,
});
stub(passesRoutes, 'passes', {
  method: 'post',
  path: '/{id}/refresh',
  summary: 'Rebuild from the connection and re-push',
  params: IdParamSchema,
  status: 202,
  response: RefreshPassResponseSchema,
});
stub(passesRoutes, 'passes', {
  method: 'post',
  path: '/{id}/rotate-link',
  summary: 'Rotate the download link',
  params: IdParamSchema,
  response: RotateLinkResponseSchema,
});
stub(passesRoutes, 'passes', {
  method: 'post',
  path: '/{id}/resend-email',
  summary: 'Email the pass to the holder',
  params: IdParamSchema,
  body: ResendEmailSchema,
  status: 202,
  response: OkSchema,
});
stub(passesRoutes, 'passes', {
  method: 'get',
  path: '/{id}/versions/{version}',
  summary: 'A retained version, for rendering',
  params: IdParamSchema.extend({ version: z.coerce.number().int() }),
  response: PassDetailSchema,
});
stub(passesRoutes, 'passes', {
  method: 'get',
  path: '/{id}/diff',
  summary: 'Diff two versions',
  params: IdParamSchema,
  query: DiffQuerySchema,
  response: z.object({
    changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
  }),
});
stub(passesRoutes, 'passes', {
  method: 'get',
  path: '/{id}/assets',
  summary: 'Per-pass image overrides',
  params: IdParamSchema,
  response: PassAssetListSchema,
});
stub(passesRoutes, 'passes', {
  method: 'put',
  path: '/{id}/assets/{name}',
  summary: 'Upload an image override (PNG body)',
  params: PassAssetParamSchema,
  response: PassAssetSchema,
});
stub(passesRoutes, 'passes', {
  method: 'delete',
  path: '/{id}/assets/{name}',
  summary: 'Remove an image override',
  params: PassAssetParamSchema,
  response: OkSchema,
});
stub(passesRoutes, 'passes', {
  method: 'post',
  path: '/bulk-reissue',
  summary: 'Rebuild all passes of a template (admin)',
  body: BulkReissueSchema,
  status: 202,
  response: BulkReissueResponseSchema,
});
