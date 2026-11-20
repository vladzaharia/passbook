import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  TemplateScanSetupBodySchema,
  TemplateScanSetupSchema,
} from '../../../shared/contracts/scan-setups.ts';
import { modeOf } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { setupTemplateScan } from './template-setup.ts';

type Router = ReturnType<typeof createRouter>;

/**
 * POST /{id}/scan-setup on the templates router, which already takes a session for every write.
 * Scanning management has no API-key scope, so a key never reaches this route.
 */
export function registerTemplateScanSetup(router: Router): void {
  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/scan-setup',
      summary: 'Set up scanning for a template: its events and a session, once',
      params: IdParamSchema,
      body: TemplateScanSetupBodySchema,
      response: TemplateScanSetupSchema,
    },
    async (c) => {
      const auth = c.var.auth;
      if (auth?.kind !== 'session') throw new UnauthenticatedError();
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
