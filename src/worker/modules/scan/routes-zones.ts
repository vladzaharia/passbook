import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { ScanVisitsResetSchema } from '../../../shared/contracts/scan-access.ts';
import { currentUserId } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { resetVisits } from './access-visits.ts';
import { passTarget } from './repo-access.ts';
import { registerConsoleInsideRoutes } from './routes-occupancy-console.ts';
import { registerZoneRoutes } from './routes-zones-key.ts';

/** Console zones: /api/v1/scan-zones. Zones are org data, shared by both modes. */
export const scanZonesRoutes = createRouter();
/** List, create, edit, archive and restore take a console session or a key, so they register before the session guard. */
registerZoneRoutes(scanZonesRoutes);
guard(scanZonesRoutes, requireTenantSession);
scanZonesRoutes.use('*', limitBody(16 * 1024));

const TAG = 'scan-zones';
registerConsoleInsideRoutes(scanZonesRoutes, TAG, 'zone');

register(
  scanZonesRoutes,
  TAG,
  {
    method: 'post',
    path: '/visits/{id}/reset',
    summary: 'Reset a pass’s visits',
    params: IdParamSchema,
    response: ScanVisitsResetSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const passId = c.req.valid('param').id;
    const pass = await passTarget(ctx.env.DB, passId);
    if (!pass || !(await getOrgAccess(ctx, auth.userId, pass.orgId)))
      throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    const authority = await tenantAuthorityOf(ctx, auth, pass.orgId, 'scanning:manage');
    if (authority.kind !== 'session') throw new UnauthenticatedError();
    return c.json(await resetVisits(ctx, currentUserId(c), passId, authority));
  },
);
