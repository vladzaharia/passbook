import type { Context } from 'hono';
import type { z } from 'zod';
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
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor, valid } from '../audit/http.ts';
import { createOrg, deleteOrg, getOrg, listOrgs, updateOrg } from './service.ts';

export const orgsRoutes = createRouter();
guard(orgsRoutes, requireAdmin);

type Ctx = Context<AppBindings>;
const idOf = (c: Ctx) => valid<{ id: string }>(c, 'param').id;

register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/',
    summary: 'List organizations',
    query: PageQuerySchema,
    response: OrgListSchema,
  },
  async (c: Ctx) => c.json(await listOrgs(serviceContext(c), valid(c, 'query'))),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'post',
    path: '/',
    summary: 'Create an organization',
    body: CreateOrgSchema,
    status: 201,
    response: OrgSchema,
  },
  async (c: Ctx) =>
    c.json(
      await createOrg(
        serviceContext(c),
        requestActor(c),
        valid<z.infer<typeof CreateOrgSchema>>(c, 'json'),
      ),
      201,
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get an organization',
    params: IdParamSchema,
    response: OrgSummarySchema,
  },
  async (c: Ctx) => c.json(await getOrg(serviceContext(c), idOf(c))),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update an organization',
    params: IdParamSchema,
    body: UpdateOrgSchema,
    response: OrgSchema,
  },
  async (c: Ctx) =>
    c.json(
      await updateOrg(
        serviceContext(c),
        requestActor(c),
        idOf(c),
        valid<z.infer<typeof UpdateOrgSchema>>(c, 'json'),
      ),
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete an organization',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c: Ctx) => {
    await deleteOrg(serviceContext(c), requestActor(c), idOf(c));
    return c.json({ ok: true });
  },
);
