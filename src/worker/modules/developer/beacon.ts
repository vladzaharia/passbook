import { OkSchema, QuickstartBeaconSchema } from '../../../shared/contracts/index.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { rateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { recordQuickstartStep } from './funnel.ts';

/**
 * `POST /developers/beacon`: the quickstart reports a step. Signed-in only: the funnel is per sandbox, so a
 * visitor with no session has nothing to count. The body names a step; the org is the session's sandbox.
 */
export const developerBeaconRoutes = createRouter();
developerBeaconRoutes.use('/beacon', limitBody(1024));
developerBeaconRoutes.use('/beacon', rateLimit('RL_PUBLIC'));

register(
  developerBeaconRoutes,
  'developer',
  {
    method: 'post',
    path: '/beacon',
    summary: 'Report a quickstart step for the funnel (org only, no personal data)',
    operationId: 'developer.postBeacon',
    auth: { human: true },
    body: QuickstartBeaconSchema,
    response: OkSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await recordQuickstartStep(serviceContext(c), auth, c.req.valid('json'));
    return c.json({ ok: true as const });
  },
);
