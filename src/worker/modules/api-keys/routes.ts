import {
  ApiKeyListQuerySchema,
  ApiKeyListSchema,
  ApiKeyScopeQuerySchema,
  CreateApiKeySchema,
  CreatedApiKeySchema,
  IdParamSchema,
  OkSchema,
  RetireApiKeySchema,
} from '../../../shared/contracts/index.ts';
import { modeFromRequest, requireSession } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { BadRequestError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { rolesGranting } from '../orgs/access.ts';
import { type ApiKeyAuthority, authorizeApiKeys } from './access.ts';
import {
  createApiKey,
  isOwnPersonalKey,
  listApiKeys,
  retireApiKey,
  revokeApiKey,
} from './service.ts';

export const apiKeysRoutes = createRouter();
guard(apiKeysRoutes, requireSession, async (c, next) => {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  c.set('auth', { ...auth, mode: modeFromRequest(c) });
  await next();
});
apiKeysRoutes.use('*', limitBody(64 * 1024));
// Missing scope is a bad request rather than an implicit platform selection.
apiKeysRoutes.use('*', async (c, next) => {
  const method = c.req.method;
  if ((method === 'GET' || method === 'DELETE') && c.req.query('orgId') === undefined) {
    throw new BadRequestError('orgId is required.');
  }
  if (method === 'POST' && c.req.header('content-type')?.includes('application/json')) {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return next();
    }
    if (body !== null && typeof body === 'object' && !Array.isArray(body) && !('orgId' in body)) {
      throw new BadRequestError('orgId is required.');
    }
  }
  await next();
});
register(
  apiKeysRoutes,
  'api-keys',
  {
    method: 'get',
    path: '/',
    summary: 'List keys for an authorized organization, or platform-wide keys with orgId=null',
    query: ApiKeyListQuerySchema,
    response: ApiKeyListSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    // Any member lists their own personal keys; the org's keys need `integrations:read`.
    const member =
      query.orgId === null
        ? null
        : await authorizeApiKeys(ctx, c.var.auth, query.orgId, 'org:read');
    const full =
      member === null ||
      (member.kind === 'session' &&
        member.roles.some((role) => rolesGranting('integrations:read').includes(role)));
    const authority = full
      ? await authorizeApiKeys(ctx, c.var.auth, query.orgId, 'integrations:read')
      : (member as ApiKeyAuthority);
    return c.json(await listApiKeys(ctx, query, authority));
  },
);
register(
  apiKeysRoutes,
  'api-keys',
  {
    method: 'post',
    path: '/',
    summary: 'Create an organization or platform API key (secret shown once)',
    body: CreateApiKeySchema,
    status: 201,
    response: CreatedApiKeySchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    // A member makes their own personal key with any role; every other key needs `integrations:manage`.
    const capability = input.kind === 'personal' ? 'org:read' : 'integrations:manage';
    const authority = await authorizeApiKeys(ctx, c.var.auth, input.orgId, capability);
    return c.json(await createApiKey(ctx, authority, input), 201);
  },
);
register(
  apiKeysRoutes,
  'api-keys',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Revoke a key for an authorized organization, or a platform-wide key with orgId=null',
    params: IdParamSchema,
    query: ApiKeyScopeQuerySchema,
    response: OkSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const { orgId } = c.req.valid('query');
    const { id } = c.req.valid('param');
    // A member may end their own personal key; anything else needs `integrations:manage`.
    let authority =
      orgId === null ? null : await authorizeApiKeys(ctx, c.var.auth, orgId, 'org:read');
    if (!authority || !(await isOwnPersonalKey(ctx, id, orgId, authority)))
      authority = await authorizeApiKeys(ctx, c.var.auth, orgId, 'integrations:manage');
    await revokeApiKey(ctx, authority, id);
    return c.json({ ok: true as const });
  },
);
register(
  apiKeysRoutes,
  'api-keys',
  {
    method: 'post',
    path: '/{id}/retire',
    summary: 'Retire a key at a later instant: it stops working then (once, never after expiry)',
    params: IdParamSchema,
    body: RetireApiKeySchema,
    response: OkSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    const { id } = c.req.valid('param');
    // As revoke: a member may retire their own personal key (rotation: make a new one, retire the old).
    let authority =
      input.orgId === null
        ? null
        : await authorizeApiKeys(ctx, c.var.auth, input.orgId, 'org:read');
    if (!authority || !(await isOwnPersonalKey(ctx, id, input.orgId, authority)))
      authority = await authorizeApiKeys(ctx, c.var.auth, input.orgId, 'integrations:manage');
    await retireApiKey(ctx, authority, id, input.retireAt);
    return c.json({ ok: true as const });
  },
);
