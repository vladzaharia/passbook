import { ApiKeyMeSchema } from '../../../shared/contracts/index.ts';
import { keyCaller } from '../../platform/auth.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { describeOwnKey } from './service.ts';

/** GET /api/v1/api-keys/me: the calling key, by bearer. Mounted ahead of the session-only key routes. */
export const apiKeyMeRoutes = createRouter();
// Only the bare path, for reads: `/me/rotate` and anything else belong to the router that checks `api-keys:write`.
apiKeyMeRoutes.get(
  '/',
  declareKeyAccess(
    async (c, next) => {
      const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
      const auth = bearer
        ? await c.var.stores.apiKeys.resolve(bearer, keyCaller(c), { limited: 'ok' })
        : null;
      if (!auth)
        throw new UnauthenticatedError('The API key is invalid or expired.', 'INVALID_API_KEY');
      c.set('auth', auth);
      await next();
    },
    { read: [], anyKey: true },
  ),
);

register(
  apiKeyMeRoutes,
  'api-keys',
  {
    method: 'get',
    path: '/',
    summary: 'The calling API key: id, name, scopes, organization, mode and use',
    response: ApiKeyMeSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'api_key') throw new UnauthenticatedError();
    const key = await describeOwnKey(serviceContext(c), auth);
    if (!key) throw new NotFoundError('API key not found.', 'API_KEY_NOT_FOUND');
    c.header('cache-control', 'no-store');
    return c.json(key);
  },
);
