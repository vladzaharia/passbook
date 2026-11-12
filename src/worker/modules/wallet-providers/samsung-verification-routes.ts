import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession } from '../passes/http.ts';
import {
  refreshSamsungProjectionEvidence,
  SamsungVerificationInputSchema,
  SamsungVerificationResultSchema,
} from './samsung-verification.ts';

/** Mount at /api/v1/wallet-providers/accounts. */
export const samsungVerificationRoutes = createRouter();
guard(samsungVerificationRoutes, requireTenantSession);
samsungVerificationRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});
register(
  samsungVerificationRoutes,
  'wallet providers',
  {
    method: 'post',
    path: '/verify',
    summary: 'Check Samsung card-template state for an independently reviewed projection',
    body: SamsungVerificationInputSchema,
    response: SamsungVerificationResultSchema,
  },
  async (c) => {
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    return c.json(
      await refreshSamsungProjectionEvidence(serviceContext(c), auth, c.req.valid('json')),
    );
  },
);
