import {
  ApiKeyListSchema,
  CreateApiKeySchema,
  CreatedApiKeySchema,
  IdParamSchema,
  OkSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const apiKeysRoutes = createRouter();
guard(apiKeysRoutes, requireAdmin);
stub(apiKeysRoutes, 'api-keys', {
  method: 'get',
  path: '/',
  summary: 'List API keys',
  response: ApiKeyListSchema,
});
stub(apiKeysRoutes, 'api-keys', {
  method: 'post',
  path: '/',
  summary: 'Create an API key (secret shown once)',
  body: CreateApiKeySchema,
  status: 201,
  response: CreatedApiKeySchema,
});
stub(apiKeysRoutes, 'api-keys', {
  method: 'delete',
  path: '/{id}',
  summary: 'Revoke an API key',
  params: IdParamSchema,
  response: OkSchema,
});
