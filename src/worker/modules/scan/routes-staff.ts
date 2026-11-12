import { z } from 'zod';
import { IdParamSchema, IdSchema } from '../../../shared/contracts/common.ts';
import {
  CreateScanStaffSchema,
  ScanStaffSchema,
  StaffPinSchema,
  UpdateScanStaffSchema,
} from '../../../shared/contracts/scanners.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { currentUserId, modeOf } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { bump } from '../../platform/counters.ts';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
} from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { authOf, requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { getStaff } from './repo-staff.ts';
import { STAFF_PAGE_MAX } from './repo-staff-page.ts';
import {
  createStaff,
  listStaff,
  resetStaffPin,
  type StaffAuthority,
  updateStaff,
} from './staff-admin.ts';

/** Console staff: /api/v1/scan-staff. Staff records are shared by an org's modes. */
export const scanStaffRoutes = createRouter();
scanStaffRoutes.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  await next();
});
guard(scanStaffRoutes, requireTenantSession);
scanStaffRoutes.use('*', limitBody(16 * 1024));
scanStaffRoutes.use('*', async (c, next) => {
  const now = c.var.clock.now();
  const window = now - (now % 60_000);
  const write = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const key = `scan:staff-admin:${write ? 'write' : 'read'}:${currentUserId(c)}`;
  if ((await bump(c.env.DB, key, window)) > (write ? 60 : 240))
    throw new RateLimitedError(Math.ceil((window + 60_000 - now) / 1000));
  await next();
});

const OrgQuery = z.object({ orgId: IdSchema });
const CreatedStaff = z.object({ staff: ScanStaffSchema, ...StaffPinSchema.shape });
const StaffList = z.object({
  items: z.array(ScanStaffSchema),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
});
const StaffListQuery = OrgQuery.extend({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(STAFF_PAGE_MAX).optional(),
  cursor: z.string().max(300).optional(),
});

type StaffCapability = 'scanning:read' | 'scanning:manage';

async function membershipFor(ctx: ServiceContext, auth: AuthContext, orgId: string) {
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return getOrgAccess(ctx, auth.userId, orgId);
}

async function staffAuthority(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  capability: StaffCapability,
): Promise<StaffAuthority> {
  const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
  if (authority.kind !== 'session') throw new ForbiddenError();
  return authority;
}

/** Resolve the staff row in the selected organization before authorizing its actual organization. */
async function authorizedStaff(ctx: ServiceContext, auth: AuthContext, orgId: string, id: string) {
  const staff = await getStaff(ctx.env.DB, orgId, id);
  if (!staff || !(await membershipFor(ctx, auth, staff.orgId)))
    throw new NotFoundError('Staff member not found.', 'SCAN_STAFF_NOT_FOUND');
  const authority = await staffAuthority(ctx, auth, staff.orgId, 'scanning:manage');
  return { staff, authority };
}

register(
  scanStaffRoutes,
  'scan-staff',
  {
    method: 'get',
    path: '/',
    summary: 'List an organization’s staff',
    query: StaffListQuery,
    response: StaffList,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const { orgId, q, limit, cursor } = c.req.valid('query');
    if (!(await membershipFor(ctx, auth, orgId))) return c.json({ items: [] });
    const authority = await staffAuthority(ctx, auth, orgId, 'scanning:read');
    return c.json(await listStaff(ctx, auth, authority, orgId, modeOf(auth), { q, limit, cursor }));
  },
);
register(
  scanStaffRoutes,
  'scan-staff',
  {
    method: 'post',
    path: '/',
    summary: 'Create a staff member and reveal their PIN once',
    body: CreateScanStaffSchema.strict(),
    response: CreatedStaff,
    status: 201,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    const input = c.req.valid('json');
    if (!(await membershipFor(ctx, auth, input.orgId)))
      throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
    const authority = await staffAuthority(ctx, auth, input.orgId, 'scanning:manage');
    return c.json(await createStaff(ctx, auth, authority, modeOf(auth), input), 201);
  },
);
register(
  scanStaffRoutes,
  'scan-staff',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update or disable a staff member',
    params: IdParamSchema,
    query: OrgQuery,
    body: UpdateScanStaffSchema.strict(),
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
    return c.json(
      await updateStaff(ctx, auth, authority, staff, modeOf(auth), c.req.valid('json')),
    );
  },
);
register(
  scanStaffRoutes,
  'scan-staff',
  {
    method: 'post',
    path: '/{id}/reset-pin',
    summary: 'Replace a staff PIN and reveal it once',
    params: IdParamSchema,
    query: OrgQuery,
    response: StaffPinSchema,
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
    return c.json(await resetStaffPin(ctx, auth, authority, staff));
  },
);
