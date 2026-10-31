import type { Context } from 'hono';
import {
  ApiKeyListSchema,
  CreateApiKeySchema,
  CreatedApiKeySchema,
  IdParamSchema,
  OkSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { limitBody } from '../auth/body-limit.ts';
import { createApiKey, listApiKeys, revokeApiKey } from './service.ts';

type C = Context<AppBindings>;

export const apiKeysRoutes = createRouter();
guard(apiKeysRoutes, requireAdmin);
apiKeysRoutes.use('*', limitBody(64 * 1024));
register(
  apiKeysRoutes,
  'api-keys',
  { method: 'get', path: '/', summary: 'List API keys', response: ApiKeyListSchema },
  async (c: C) => c.json({ items: await listApiKeys(serviceContext(c)) }),
);
register(
  apiKeysRoutes,
  'api-keys',
  {
    method: 'post',
    path: '/',
    summary: 'Create an API key (secret shown once)',
    body: CreateApiKeySchema,
    status: 201,
    response: CreatedApiKeySchema,
  },
  async (c: C) => {
    const input = CreateApiKeySchema.parse(await c.req.json());
    return c.json(await createApiKey(serviceContext(c), currentUserId(c), input), 201);
  },
);
register(
  apiKeysRoutes,
  'api-keys',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Revoke an API key',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c: C) => {
    await revokeApiKey(serviceContext(c), currentUserId(c), c.req.param('id') ?? '');
    return c.json({ ok: true as const });
  },
);
