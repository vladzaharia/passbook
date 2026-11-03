import {
  ApiKeyListQuerySchema,
  ApiKeyListSchema,
  CreateApiKeySchema,
  CreatedApiKeySchema,
  IdParamSchema,
  OkSchema,
} from '../../../shared/contracts/index.ts';
import { currentUserId, requireAdmin } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { createApiKey, listApiKeys, revokeApiKey } from './service.ts';

export const apiKeysRoutes = createRouter();
guard(apiKeysRoutes, requireAdmin);
apiKeysRoutes.use('*', limitBody(64 * 1024));
register(
  apiKeysRoutes,
  'api-keys',
  {
    method: 'get',
    path: '/',
    summary: 'List API keys',
    query: ApiKeyListQuerySchema,
    response: ApiKeyListSchema,
  },
  async (c) => c.json(await listApiKeys(serviceContext(c), c.req.valid('query'))),
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
  async (c) => {
    const input = c.req.valid('json');
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
  async (c) => {
    await revokeApiKey(serviceContext(c), currentUserId(c), c.req.valid('param').id);
    return c.json({ ok: true as const });
  },
);
