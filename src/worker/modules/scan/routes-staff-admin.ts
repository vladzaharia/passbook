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
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { clientIp } from '../../platform/rate-limit.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { authOf, type C, type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { credentialOnce } from './credential-once.ts';
import { charged, orgOf } from './key-credentials.ts';
import { STAFF_PAGE_MAX } from './repo-staff-page.ts';
import {
  committedStaffOf,
  createStaff,
  listStaff,
  resetStaffPin,
  type StaffAuthority,
  staffRateLimit,
  staffTarget,
  updateStaff,
} from './staff-admin.ts';
import {
  createStaffByKey,
  listStaffByKey,
  resetStaffPinByKey,
  updateStaffByKey,
} from './staff-admin-key.ts';

type Router = ReturnType<typeof createRouter>;

export const OrgQuery = z.object({ orgId: IdSchema });
const CreatedStaff = z.object({ staff: ScanStaffSchema, ...StaffPinSchema.shape });
const StaffList = z.object({
  items: z.array(ScanStaffSchema),
  /** Present when PIN-only sign-in is off after repeated wrong PINs. */
  pinOnlyOff: z.literal(true).optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
});
/** An org-bound key may omit `orgId`; a session names one. */
const KeyOrgQuery = z.object({ orgId: IdSchema.optional() });
const StaffListQuery = KeyOrgQuery.extend({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(STAFF_PAGE_MAX).optional(),
  cursor: z.string().max(300).optional(),
});

type StaffCapability = 'scanning:read' | 'scanning:manage';

export async function membershipFor(ctx: ServiceContext, auth: AuthContext, orgId: string) {
  if (auth.kind !== 'session') throw new UnauthenticatedError();
  return getOrgAccess(ctx, auth.userId, orgId);
}

export async function staffAuthority(
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
export async function authorizedStaff(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  id: string,
) {
  const staff = await staffTarget(ctx, orgId, id);
  if (!staff || !(await membershipFor(ctx, auth, staff.orgId)))
    throw new NotFoundError('Staff member not found.', 'SCAN_STAFF_NOT_FOUND');
  const authority = await staffAuthority(ctx, auth, staff.orgId, 'scanning:manage');
  return { staff, authority };
}

const ADMIN = { scope: 'scanning:admin', capability: 'scanning:manage' } as const;

function sessionOf(auth: AuthContext) {
  if (auth.kind !== 'session') throw new ForbiddenError();
  return auth;
}
function sessionAuthorityOf(authority: TenantPassWrite): StaffAuthority {
  if (authority.kind !== 'session') throw new ForbiddenError();
  return authority;
}

/** The caller: a console session, or a key (`scanning:admin`), each limited under its own id. */
async function caller(c: C, write: boolean) {
  const ctx = serviceContext(c);
  const auth = authOf(c);
  if (auth.kind !== 'session' && auth.kind !== 'api_key') throw new UnauthenticatedError();
  const actorId = auth.kind === 'api_key' ? auth.keyId : currentUserId(c);
  await staffRateLimit(ctx, actorId, write);
  return { ctx, auth, actorId, ip: ipPrefix(clientIp(c)) };
}

/** A key finds staff only in its own org: another org, and a platform key, get the missing-staff 404. */
async function keyStaff(k: Awaited<ReturnType<typeof caller>>, orgId: string, id: string) {
  const staff =
    k.auth.kind === 'api_key' && k.auth.orgId === orgId
      ? await staffTarget(k.ctx, orgId, id)
      : null;
  if (!staff) throw new NotFoundError('Staff member not found.', 'SCAN_STAFF_NOT_FOUND');
  return staff;
}

/**
 * List, create, edit and reset a PIN: a console session, or a live org-bound `scanning:admin` key.
 * A key's list is the plain accounts. A PIN is in the answer of the call that made it; with an
 * `Idempotency-Key` a replay returns the same ids and a null PIN. Registered before the session guard.
 */
export function registerStaffAdmin(router: Router): void {
  register(
    router,
    'scan-staff',
    {
      method: 'get',
      path: '/',
      summary: 'List an organization’s staff',
      // No capability: an org the caller cannot see is an empty page.
      auth: { scope: 'scanning:admin' },
      query: StaffListQuery,
      response: StaffList,
    },
    async (c) => {
      const k = await caller(c, false);
      const { orgId: given, q, limit, cursor } = c.req.valid('query');
      const orgId = orgOf(k.auth, given);
      if (k.auth.kind === 'api_key') {
        // A platform key (no org) finds nothing, as on every scanning list; another org's key reads an empty page.
        if (k.auth.orgId === null)
          throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
        if (k.auth.orgId !== orgId) return c.json({ items: [] });
        const authority = await tenantAuthorityOf(k.ctx, k.auth, orgId, 'scanning:manage');
        return c.json(
          await listStaffByKey(k.ctx, authority, k.actorId, orgId, { q, limit, cursor }),
        );
      }
      if (k.auth.kind !== 'session' || !(await membershipFor(k.ctx, k.auth, orgId)))
        return c.json({ items: [] });
      const authority = await staffAuthority(k.ctx, k.auth, orgId, 'scanning:read');
      return c.json(
        await listStaff(k.ctx, k.auth, authority, orgId, modeOf(k.auth), { q, limit, cursor }),
      );
    },
  );
  register(
    router,
    'scan-staff',
    {
      method: 'post',
      path: '/',
      summary: 'Create a staff member and reveal their PIN once',
      auth: ADMIN,
      body: CreateScanStaffSchema.strict(),
      response: CreatedStaff,
      status: 201,
    },
    async (c) => {
      const k = await caller(c, true);
      const input = c.req.valid('json');
      if (k.auth.kind === 'api_key' && k.auth.orgId !== input.orgId)
        throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
      if (k.auth.kind === 'session' && !(await membershipFor(k.ctx, k.auth, input.orgId)))
        throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
      const authority = await tenantAuthorityOf(k.ctx, k.auth, input.orgId, 'scanning:manage');
      return credentialOnce(c, k.ctx, {
        orgId: input.orgId,
        body: input,
        status: 201,
        execute: () =>
          charged(k.ctx, authority, 1, (committed) =>
            authority.kind === 'api_key'
              ? createStaffByKey(k.ctx, authority, k.actorId, input, k.ip, committed)
              : createStaff(
                  k.ctx,
                  sessionOf(k.auth),
                  sessionAuthorityOf(authority),
                  modeOf(k.auth),
                  input,
                ),
          ),
        redact: (v) => ({ staff: v.staff, pin: null }),
      });
    },
  );
  register(
    router,
    'scan-staff',
    {
      method: 'patch',
      path: '/{id}',
      summary: 'Update or disable a staff member',
      auth: ADMIN,
      params: IdParamSchema,
      query: KeyOrgQuery,
      body: UpdateScanStaffSchema.strict(),
      response: ScanStaffSchema,
    },
    async (c) => {
      const k = await caller(c, true);
      const orgId = orgOf(k.auth, c.req.valid('query').orgId);
      const { id } = c.req.valid('param');
      if (k.auth.kind === 'api_key') {
        const staff = await keyStaff(k, orgId, id);
        const authority = await tenantAuthorityOf(k.ctx, k.auth, staff.orgId, 'scanning:manage');
        return c.json(
          await updateStaffByKey(k.ctx, authority, k.actorId, staff, c.req.valid('json'), k.ip),
        );
      }
      const { staff, authority } = await authorizedStaff(k.ctx, k.auth, orgId, id);
      return c.json(
        await updateStaff(
          k.ctx,
          sessionOf(k.auth),
          authority,
          staff,
          modeOf(k.auth),
          c.req.valid('json'),
        ),
      );
    },
  );
  register(
    router,
    'scan-staff',
    {
      method: 'post',
      path: '/{id}/reset-pin',
      summary: 'Replace a staff PIN and reveal it once',
      auth: ADMIN,
      params: IdParamSchema,
      query: KeyOrgQuery,
      response: StaffPinSchema,
    },
    async (c) => {
      const k = await caller(c, true);
      const orgId = orgOf(k.auth, c.req.valid('query').orgId);
      const { id } = c.req.valid('param');
      const found =
        k.auth.kind === 'api_key'
          ? await keyStaff(k, orgId, id)
          : (await authorizedStaff(k.ctx, k.auth, orgId, id)).staff;
      const authority = await tenantAuthorityOf(k.ctx, k.auth, found.orgId, 'scanning:manage');
      return credentialOnce(c, k.ctx, {
        orgId: found.orgId,
        body: { orgId },
        status: 200,
        execute: () =>
          charged(k.ctx, authority, 1, (committed) =>
            authority.kind === 'api_key'
              ? resetStaffPinByKey(k.ctx, authority, k.actorId, found, k.ip, committed)
              : resetStaffPin(k.ctx, sessionOf(k.auth), sessionAuthorityOf(authority), found),
          ),
        redact: (v) => ({ ...v, pin: null }),
      });
    },
  );
}

export { committedStaffOf };
