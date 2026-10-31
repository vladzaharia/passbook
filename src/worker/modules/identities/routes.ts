import {
  IdentityListSchema,
  IdentitySchema,
  IdParamSchema,
  OkSchema,
  UpdateIdentitySchema,
  UploadIdentitySchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const identitiesRoutes = createRouter();
guard(identitiesRoutes, requireAdmin);

stub(identitiesRoutes, 'identities', {
  method: 'get',
  path: '/',
  summary: 'List Apple identities',
  response: IdentityListSchema,
});
stub(identitiesRoutes, 'identities', {
  method: 'post',
  path: '/',
  summary: 'Upload an Apple identity',
  body: UploadIdentitySchema,
  status: 201,
  response: IdentitySchema,
});
stub(identitiesRoutes, 'identities', {
  method: 'get',
  path: '/{id}',
  summary: 'Get an Apple identity',
  params: IdParamSchema,
  response: IdentitySchema,
});
stub(identitiesRoutes, 'identities', {
  method: 'patch',
  path: '/{id}',
  summary: 'Update an Apple identity',
  params: IdParamSchema,
  body: UpdateIdentitySchema,
  response: IdentitySchema,
});
stub(identitiesRoutes, 'identities', {
  method: 'delete',
  path: '/{id}',
  summary: 'Delete an Apple identity',
  params: IdParamSchema,
  response: OkSchema,
});
