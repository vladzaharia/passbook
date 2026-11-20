import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  TemplateScanSetupBodySchema,
  TemplateScanSetupSchema,
} from '../../../shared/contracts/scan-template-setup.ts';
import { modeOf } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { setupTemplateScan } from './template-setup.ts';

type Router = ReturnType<typeof createRouter>;

/**
 * POST /{id}/scan-setup on the templates router. A console session with `scanning:manage`, or a key with
 * the `scanning:write` scope, calls it; the router's session-only write guard steps aside for this path.
 */
export function registerTemplateScanSetup(router: Router): void {
  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/scan-setup',
      summary: 'Set up scanning for a template: its events and a session, once',
      auth: { scope: 'scanning:write', capability: 'scanning:manage' },
      params: IdParamSchema,
      body: TemplateScanSetupBodySchema,
      response: TemplateScanSetupSchema,
    },
    async (c) => {
      const auth = c.var.auth;
      if (auth?.kind !== 'session' && auth?.kind !== 'api_key') throw new UnauthenticatedError();
      return c.json(
        await setupTemplateScan(
          serviceContext(c),
          auth,
          modeOf(auth),
          c.req.valid('param').id,
          c.req.valid('json'),
        ),
      );
    },
  );
}
