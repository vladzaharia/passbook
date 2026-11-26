import {
  ApiKeyActivityQuerySchema,
  ApiKeyActivitySchema,
  ApiKeyDetailSchema,
  ApiKeyScopeQuerySchema,
  IdParamSchema,
  RotateApiKeySchema,
  RotatedApiKeySchema,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { viaToken } from '../../platform/auth-workbench.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { seesAccountEmails } from '../passes/account-email.ts';
import { authOf, orgIdOf } from '../passes/http.ts';
import { type ApiKeyAuthority, authorizeApiKeys } from './access.ts';
import { idempotentSecret } from './idempotent-secret.ts';
import { getKey } from './repo.ts';
import { isOwnPersonalKey } from './service.ts';
import { getApiKey, getApiKeyActivity } from './service-detail.ts';
import { rotateApiKey } from './service-rotate.ts';
import { rotatableUnderToken } from './workbench-cap.ts';

/** A rotation as stored for a replay: the new key without its secret. */
const withoutSecret = ({
  key: { secret: _secret, ...key },
  previous,
}: {
  key: { secret: string };
  previous: unknown;
}) => ({
  key,
  previous,
});

type Router = ReturnType<typeof createRouter>;

/**
 * Authority over the key `id`. A key reaches its own children; a member reaches their own personal key
 * (as `org:read`) and any other key with `capability`.
 */
export async function authorizeKey(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string | null,
  id: string,
  capability: 'integrations:read' | 'integrations:manage' | 'audit:read',
): Promise<ApiKeyAuthority> {
  // Under a Workbench token a Live key, or one of another org, is not found.
  if (viaToken(auth) && (await getKey(ctx.env.DB, id, orgId))?.mode !== 'test')
    throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
  if (auth?.kind === 'api_key') return authorizeApiKeys(ctx, auth, orgId, 'integrations:manage');
  const member = orgId === null ? null : await authorizeApiKeys(ctx, auth, orgId, 'org:read');
  if (member && (await isOwnPersonalKey(ctx, id, orgId, member))) return member;
  return authorizeApiKeys(ctx, auth, orgId, capability);
}

/**
 * A token rotates only a key it could have made (`workbench-cap.ts`): a fresh secret for a wider or longer-lived
 * key would outlive the token. Any other key is not found, like a Live one.
 */
async function assertRotatable(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  orgId: string | null,
): Promise<void> {
  if (!viaToken(auth)) return;
  if (!rotatableUnderToken(await getKey(ctx.env.DB, id, orgId), ctx.clock.now()))
    throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
}

/** Rotation, detail and activity, on the router that guards sessions and `api-keys:write` keys. */
export function registerKeyFamilyRoutes(router: Router): void {
  // Registered ahead of `/{id}/rotate`: `me` is not an id.
  register(
    router,
    'api-keys',
    {
      method: 'post',
      path: '/me/rotate',
      summary:
        'Replace the calling key: the new secret works at once, the old one after the overlap',
      body: RotateApiKeySchema.omit({ orgId: true }),
      status: 201,
      response: RotatedApiKeySchema,
    },
    async (c) => {
      const auth = c.var.auth;
      if (auth?.kind !== 'api_key')
        throw new UnauthenticatedError('Call this with an API key.', 'API_KEY_REQUIRED');
      const ctx = serviceContext(c);
      await assertRotatable(ctx, auth, auth.keyId, auth.orgId);
      const authority = await authorizeApiKeys(ctx, auth, auth.orgId, 'integrations:manage');
      const { overlapHours } = c.req.valid('json');
      c.header('cache-control', 'no-store');
      return idempotentSecret(
        c,
        ctx,
        auth.orgId,
        { overlapHours },
        201,
        () => rotateApiKey(ctx, authority, auth.keyId, overlapHours),
        withoutSecret,
      );
    },
  );
  register(
    router,
    'api-keys',
    {
      method: 'post',
      path: '/{id}/rotate',
      summary: 'Replace a key: the new secret works at once, the old one retires after the overlap',
      params: IdParamSchema,
      body: RotateApiKeySchema,
      status: 201,
      response: RotatedApiKeySchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { id } = c.req.valid('param');
      const { orgId, overlapHours } = c.req.valid('json');
      await assertRotatable(ctx, c.var.auth, id, orgId);
      const authority = await authorizeKey(ctx, c.var.auth, orgId, id, 'integrations:manage');
      c.header('cache-control', 'no-store');
      return idempotentSecret(
        c,
        ctx,
        orgId,
        { orgId, overlapHours },
        201,
        () => rotateApiKey(ctx, authority, id, overlapHours),
        withoutSecret,
      );
    },
  );
  register(
    router,
    'api-keys',
    {
      method: 'get',
      path: '/{id}',
      summary: 'A key with its parent, successor, children count and last use',
      params: IdParamSchema,
      query: ApiKeyScopeQuerySchema,
      response: ApiKeyDetailSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { id } = c.req.valid('param');
      const orgId = orgIdOf(authOf(c), c.req.valid('query').orgId);
      const authority = await authorizeKey(ctx, c.var.auth, orgId, id, 'integrations:read');
      return c.json(await getApiKey(ctx, authority, id, seesAccountEmails(authority)));
    },
  );
  register(
    router,
    'api-keys',
    {
      method: 'get',
      path: '/{id}/activity',
      summary:
        'What a key did lately: calls by action and the latest calls, without bodies or secrets',
      params: IdParamSchema,
      query: ApiKeyActivityQuerySchema,
      response: ApiKeyActivitySchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { id } = c.req.valid('param');
      const { limit } = c.req.valid('query');
      const orgId = orgIdOf(authOf(c), c.req.valid('query').orgId);
      // The audit log is behind `audit:read`: a member sees a key's trail with it, or their own personal key's.
      const authority = await authorizeKey(ctx, c.var.auth, orgId, id, 'audit:read');
      return c.json(await getApiKeyActivity(ctx, authority, id, limit));
    },
  );
}
