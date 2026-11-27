import { z } from 'zod';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import { ScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import { currentUserId } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { wholeMountUse } from '../../platform/router-scope.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authOf, requireTenantSession } from '../passes/http.ts';
import {
  authorizedStaff,
  membershipFor,
  OrgQuery,
  registerStaffAdmin,
  staffAuthority,
} from './routes-staff-admin.ts';
import { committedStaffOf, staffRateLimit } from './staff-admin.ts';
import { resetUntaggedPins, unlockStaffPin } from './staff-admin-pins.ts';

/** Console staff: /api/v1/scan-staff. Staff records are shared by an org's modes. */
export const scanStaffRoutes = createRouter();
scanStaffRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  await next();
});
scanStaffRoutes.use('*', limitBody(16 * 1024));
/** List, create, edit and reset take a session or a `scanning:admin` key: they register before the session guard. */
registerStaffAdmin(scanStaffRoutes);
// Dedicated prefix: the session guard covers every path (an anonymous unknown path is a 401), and the rate limit below needs the session.
wholeMountUse(scanStaffRoutes, requireTenantSession);
scanStaffRoutes.use('*', async (c, next) => {
  await staffRateLimit(
    serviceContext(c),
    currentUserId(c),
    c.req.method !== 'GET' && c.req.method !== 'HEAD',
  );
  await next();
});

register(
  scanStaffRoutes,
  'scan-staff',
  {
    method: 'post',
    path: '/{id}/unlock-pin',
    summary: 'Lift a staff member’s daily PIN lock',
    params: IdParamSchema,
    query: OrgQuery,
    response: ScanStaffSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const { staff, authority } = await authorizedStaff(
      ctx,
      auth,
      c.req.valid('query').orgId,
      c.req.valid('param').id,
    );
    await unlockStaffPin(ctx, authority, staff);
    return c.json(await committedStaffOf(ctx, auth, authority, staff.id));
  },
);
register(
  scanStaffRoutes,
  'scan-staff',
  {
    method: 'post',
    path: '/reset-untagged',
    summary: 'Ask everyone whose PIN predates PIN tags for a new PIN at their next sign-in',
    query: OrgQuery,
    response: z.object({ flagged: z.number().int() }),
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const { orgId } = c.req.valid('query');
    if (!(await membershipFor(ctx, auth, orgId)))
      throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
    const authority = await staffAuthority(ctx, auth, orgId, 'scanning:manage');
    return c.json(await resetUntaggedPins(ctx, authority, orgId));
  },
);
