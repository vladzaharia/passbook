import {
  CreateOrgSchema,
  IdParamSchema,
  OkSchema,
  OrgListSchema,
  OrgSchema,
  OrgSummarySchema,
  PageQuerySchema,
  UpdateOrgSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const orgsRoutes = createRouter();
guard(orgsRoutes, requireAdmin);

stub(orgsRoutes, 'orgs', {
  method: 'get',
  path: '/',
  summary: 'List organizations',
  query: PageQuerySchema,
  response: OrgListSchema,
});
stub(orgsRoutes, 'orgs', {
  method: 'post',
  path: '/',
  summary: 'Create an organization',
  body: CreateOrgSchema,
  status: 201,
  response: OrgSchema,
});
stub(orgsRoutes, 'orgs', {
  method: 'get',
  path: '/{id}',
  summary: 'Get an organization',
  params: IdParamSchema,
  response: OrgSummarySchema,
});
stub(orgsRoutes, 'orgs', {
  method: 'patch',
  path: '/{id}',
  summary: 'Update an organization',
  params: IdParamSchema,
  body: UpdateOrgSchema,
  response: OrgSchema,
});
stub(orgsRoutes, 'orgs', {
  method: 'delete',
  path: '/{id}',
  summary: 'Delete an organization',
  params: IdParamSchema,
  response: OkSchema,
});
