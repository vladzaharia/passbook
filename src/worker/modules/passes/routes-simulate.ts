import {
  IdParamSchema,
  SimulatePassResponseSchema,
  SimulatePassSchema,
} from '../../../shared/contracts/index.ts';
import { AppError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { checkRateLimit, secondsToReset } from '../../platform/rate-limit.ts';
import { actorFor, authOf, passScopeOf, svc } from './http.ts';
import { tenantPassForWrite } from './pass-access.ts';
import { simulatePass } from './simulate.ts';

/** Mounted on the passes router, which already requires passes:write for POST. */
export function registerSimulateRoutes(passesRoutes: ReturnType<typeof createRouter>): void {
  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/{id}/simulate',
      summary: 'Send a real Test event for a Test pass: install, scan, push failure and more',
      params: IdParamSchema,
      body: SimulatePassSchema,
      status: 201,
      response: SimulatePassResponseSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const id = c.req.valid('param').id;
      const { pass, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      if (!(await checkRateLimit(ctx.env, 'RL_SIMULATE', `org:${pass.orgId}`)))
        throw new AppError(
          'SIMULATE_RATE_LIMITED',
          429,
          'Too many simulated events. Try again in a minute.',
          { headers: { 'retry-after': String(secondsToReset(ctx.clock.now())) } },
        );
      return c.json(
        await simulatePass(ctx, actorFor(c), pass, c.req.valid('json'), authority),
        201,
      );
    },
  );
}
