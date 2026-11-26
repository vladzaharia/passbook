import {
  ApiKeyListQuerySchema,
  ApiKeyListSchema,
  ApiKeyScopeQuerySchema,
  CreateApiKeySchema,
  IdParamSchema,
  MintedApiKeySchema,
  OkSchema,
  RetireApiKeySchema,
  RetiredApiKeySchema,
} from '../../../shared/contracts/index.ts';
import { requireCaller } from '../../platform/auth.ts';
import { viaToken } from '../../platform/auth-workbench.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { BadRequestError, workbenchTestOnly } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import { serviceContext } from '../../platform/service-context.ts';
import {
  assertStrictSignIn,
  peekBody,
  requireStepUp,
  STEP_UP_SECONDS,
} from '../../platform/sign-in-guard.ts';
import { rolesGranting } from '../orgs/access.ts';
import { authOf, orgIdOf } from '../passes/http.ts';
import { type ApiKeyAuthority, authorizeApiKeys } from './access.ts';
import { idempotentSecret } from './idempotent-secret.ts';
import { authorizeKey, registerKeyFamilyRoutes } from './routes-family.ts';
import { createApiKey, listApiKeys, retireApiKey, revokeApiKey } from './service.ts';

/** Under a Workbench token a new key is a Test key: `mode` left out means Test, and Live is refused. */
async function testOnlyUnderToken<T extends { mode: 'live' | 'test' }>(
  c: Parameters<typeof peekBody>[0],
  input: T,
): Promise<T> {
  if (!viaToken(c.var.auth)) return input;
  if ((await peekBody(c)).mode === undefined) return { ...input, mode: 'test' };
  if (input.mode !== 'test') throw workbenchTestOnly();
  return input;
}

export const apiKeysRoutes = createRouter();
// A signed-in member, or a key holding `api-keys:write` (it reaches its own children). `me` is the key route's.
guard(
  apiKeysRoutes,
  declareKeyAccess(requireCaller({ scope: 'api-keys:write' }), {
    read: ['api-keys:write'],
    write: ['api-keys:write'],
    only: /^\/api\/v1\/api-keys(?!\/me$)/,
  }),
);
// Making or rotating a key is a strong, recent sign-in with no email-link grace: a key outlives the grace.
apiKeysRoutes.use('*', async (c, next) => {
  const auth = c.var.auth;
  if (auth?.kind === 'session' && c.req.method === 'POST' && !c.req.path.endsWith('/retire'))
    assertStrictSignIn(c, auth);
  await next();
});
// Minting and rotating (a key, of any kind or scope, scanning:admin included) need a recent sign-in.
apiKeysRoutes.post('/', requireStepUp(STEP_UP_SECONDS));
apiKeysRoutes.post('/:id/rotate', requireStepUp(STEP_UP_SECONDS));
apiKeysRoutes.use('*', limitBody(64 * 1024));
// Missing scope is a bad request rather than an implicit platform selection.
apiKeysRoutes.use('*', async (c, next) => {
  const method = c.req.method;
  const ownOrg = c.var.auth?.kind === 'api_key' && c.var.auth.orgId !== null;
  if ((method === 'GET' || method === 'DELETE') && !ownOrg && c.req.query('orgId') === undefined) {
    throw new BadRequestError('orgId is required.');
  }
  if (
    method === 'POST' &&
    !c.req.path.endsWith('/me/rotate') &&
    c.req.header('content-type')?.includes('application/json')
  ) {
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
registerKeyFamilyRoutes(apiKeysRoutes);
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
    const q = c.req.valid('query');
    const query = { ...q, orgId: orgIdOf(authOf(c), q.orgId) };
    // A key lists its own children.
    if (c.var.auth?.kind === 'api_key')
      return c.json(
        await listApiKeys(
          ctx,
          query,
          await authorizeApiKeys(ctx, c.var.auth, query.orgId, 'integrations:manage'),
        ),
      );
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
    response: MintedApiKeySchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const input = await testOnlyUnderToken(c, c.req.valid('json'));
    // A member makes their own personal key with any role; every other key needs `integrations:manage`.
    const capability = input.kind === 'personal' ? 'org:read' : 'integrations:manage';
    const authority = await authorizeApiKeys(ctx, c.var.auth, input.orgId, capability);
    return idempotentSecret(
      c,
      ctx,
      input.orgId,
      input,
      201,
      () => createApiKey(ctx, authority, input),
      ({ secret: _secret, ...stored }) => stored,
    );
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
    const orgId = orgIdOf(authOf(c), c.req.valid('query').orgId);
    const { id } = c.req.valid('param');
    // A member may end their own personal key; anything else needs `integrations:manage`; a key, its children.
    const authority = await authorizeKey(ctx, c.var.auth, orgId, id, 'integrations:manage');
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
    response: RetiredApiKeySchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    const { id } = c.req.valid('param');
    // As revoke: a member may retire their own personal key.
    const authority = await authorizeKey(ctx, c.var.auth, input.orgId, id, 'integrations:manage');
    await retireApiKey(ctx, authority, id, input.retireAt);
    return c.json({ ok: true as const });
  },
);
