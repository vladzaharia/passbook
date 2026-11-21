import { z } from 'zod';
import {
  ScanSetupAnswerSchema,
  ScanSetupIntentSchema,
} from '../../../shared/contracts/scan-setup-intent.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { applyScanSetup, dryRunSetup } from './setup-intent.ts';

type Router = ReturnType<typeof createRouter>;

/**
 * POST /setup on the scanning-sessions router: a console session with `scanning:manage`, or a key with
 * the `scanning:write` scope. The router's session-only guard steps aside for this path.
 */
export function registerScanSetup(router: Router): void {
  register(
    router,
    'scanners',
    {
      method: 'post',
      path: '/setup',
      summary: 'Set up scanning in one call (Idempotency-Key supported)',
      auth: {
        scope: ['scanning:admin', 'scanning:write'],
        capability: 'scanning:manage',
        feature: 'scanning.devices',
      },
      query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
      body: ScanSetupIntentSchema,
      response: ScanSetupAnswerSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const auth = c.var.auth;
      if (auth?.kind !== 'session' && auth?.kind !== 'api_key') throw new UnauthenticatedError();
      const intent = c.req.valid('json');
      if (c.req.valid('query').dryRun === 'true')
        return c.json(await dryRunSetup(ctx, auth, intent));
      const result = await applyScanSetup(ctx, auth, {
        intent,
        idempotencyKey: c.req.header('idempotency-key'),
        method: c.req.method,
        path: c.req.path,
        origin: new URL(c.req.url).origin,
      });
      if (result.replayed) c.header('Idempotent-Replayed', 'true');
      return c.json(result);
    },
  );
}
