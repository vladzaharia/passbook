import {
  BundleListQuerySchema,
  BundleListSchema,
  BundleSchema,
  CreateBundleSchema,
  IdParamSchema,
  OkSchema,
  SendBundleEmailSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, modeOf } from '../../platform/auth.ts';
import { ValidationError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { idempotencyKeyOf } from '../delivery/idempotent-send.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  passScopeOf,
  requireTenantSessionOrApiKey,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
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
  requireTenantSessionOrApiKey(methodScope({ read: 'passes:read', write: 'passes:write' })),
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
    const auth = authOf(c);
    const orgId = q.orgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
    if (!orgId)
      throw new ValidationError('Send orgId to choose an organization.', [], 'ORG_REQUIRED');
    assertOrg(c, orgId);
    await tenantAuthorityOf(svc(c), auth, orgId, 'passes:read');
    return c.json(
      await listBundles(svc(c), {
        orgId,
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
    return c.json(
      await createBundle(svc(c), actorFor(c), modeOf(authOf(c)), body, {
        kind: 'tenant',
        auth: authOf(c),
      }),
      201,
    );
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
  async (c) =>
    c.json(await getBundleDto(svc(c), c.req.valid('param').id, passScopeOf(c), authOf(c))),
);

register(
  bundlesRoutes,
  'bundles',
  {
    method: 'post',
    path: '/{id}/send-email',
    summary: 'Email the bundle link (Idempotency-Key supported)',
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
      passScopeOf(c),
      { kind: 'tenant', auth: authOf(c) },
      idempotencyKeyOf(c.req.header('idempotency-key')),
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
    c.json(
      await rotateBundleLink(svc(c), actorFor(c), c.req.valid('param').id, passScopeOf(c), {
        kind: 'tenant',
        auth: authOf(c),
      }),
    ),
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
    await deleteBundle(svc(c), actorFor(c), c.req.valid('param').id, passScopeOf(c), {
      kind: 'tenant',
      auth: authOf(c),
    });
    return c.json({ ok: true as const });
  },
);
