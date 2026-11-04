import {
  BundleListQuerySchema,
  BundleListSchema,
  BundleSchema,
  CreateBundleSchema,
  IdParamSchema,
  OkSchema,
  SendBundleEmailSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, modeOf, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { actorFor, assertOrg, authOf, orgScopeOf, svc } from '../passes/http.ts';
import {
  createBundle,
  deleteBundle,
  getBundleDto,
  listBundles,
  rotateBundleLink,
  sendBundleEmail,
} from './service.ts';

/** /api/v1/bundles: a bundle is 1-10 passes of one org and mode behind one capability link. */
export const bundlesRoutes = createRouter();
guard(
  bundlesRoutes,
  requireApiKeyOrAdmin(methodScope({ read: 'passes:read', write: 'passes:write' })),
);

register(
  bundlesRoutes,
  'bundles',
  {
    method: 'get',
    path: '/',
    summary: 'List bundles',
    query: BundleListQuerySchema,
    response: BundleListSchema,
  },
  async (c) => {
    const q = c.req.valid('query');
    if (q.orgId) assertOrg(c, q.orgId);
    return c.json(
      await listBundles(svc(c), {
        orgScope: orgScopeOf(c),
        orgId: q.orgId,
        mode: modeOf(authOf(c)),
        passId: q.passId,
        cursor: q.cursor,
        limit: q.limit,
      }),
    );
  },
);

register(
  bundlesRoutes,
  'bundles',
  {
    method: 'post',
    path: '/',
    summary: 'Create a bundle of up to 10 passes',
    body: CreateBundleSchema,
    status: 201,
    response: BundleSchema,
  },
  async (c) => {
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    return c.json(await createBundle(svc(c), actorFor(c), modeOf(authOf(c)), body), 201);
  },
);

register(
  bundlesRoutes,
  'bundles',
  {
    method: 'get',
    path: '/{id}',
    summary: 'One bundle',
    params: IdParamSchema,
    response: BundleSchema,
  },
  async (c) => c.json(await getBundleDto(svc(c), c.req.valid('param').id, orgScopeOf(c))),
);

register(
  bundlesRoutes,
  'bundles',
  {
    method: 'post',
    path: '/{id}/send-email',
    summary: 'Email the bundle link',
    params: IdParamSchema,
    body: SendBundleEmailSchema,
    status: 202,
    response: OkSchema,
  },
  async (c) => {
    await sendBundleEmail(
      svc(c),
      actorFor(c),
      c.req.valid('param').id,
      c.req.valid('json'),
      orgScopeOf(c),
    );
    return c.json({ ok: true as const }, 202);
  },
);

register(
  bundlesRoutes,
  'bundles',
  {
    method: 'post',
    path: '/{id}/rotate-link',
    summary: 'Replace the link; the old one stops working',
    params: IdParamSchema,
    response: BundleSchema,
  },
  async (c) =>
    c.json(await rotateBundleLink(svc(c), actorFor(c), c.req.valid('param').id, orgScopeOf(c))),
);

register(
  bundlesRoutes,
  'bundles',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete the bundle and revoke its link',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    await deleteBundle(svc(c), actorFor(c), c.req.valid('param').id, orgScopeOf(c));
    return c.json({ ok: true as const });
  },
);
