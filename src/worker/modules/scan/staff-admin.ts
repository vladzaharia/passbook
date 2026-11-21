import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  CreateScanStaffSchema,
  ScanStaffSchema,
  UpdateScanStaffSchema,
} from '../../../shared/contracts/scanners.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { bump } from '../../platform/counters.ts';
import { macKeyVersion } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { adminGrant, audited } from './repo-admin-grant.ts';
import {
  addStaffInsert,
  addStaffPinRotate,
  addStaffUpdate,
  addUnbindStaffEverywhere,
  getStaff,
  getStaffBase,
  type ScanStaffRow,
} from './repo-staff.ts';
import {
  decodeStaffCursor,
  encodeStaffCursor,
  STAFF_PAGE_LIMIT,
  STAFF_PAGE_MAX,
  type StaffPage,
} from './repo-staff-page.ts';
import { staffViews } from './staff-admin-views.ts';
import { hashPin } from './staff-pin.ts';
import { newUniquePin } from './staff-pin-unique.ts';

/** One minute window per user: 60 writes or 240 reads. */
export async function staffRateLimit(ctx: ServiceContext, userId: string, write: boolean) {
  const now = ctx.clock.now();
  const window = now - (now % 60_000);
  const key = `scan:staff-admin:${write ? 'write' : 'read'}:${userId}`;
  if ((await bump(ctx.env.DB, key, window)) > (write ? 60 : 240))
    throw new RateLimitedError(Math.ceil((window + 60_000 - now) / 1000));
}

/** The staff row in the named organization, before any tenant authority exists for it. */
export const staffTarget = (ctx: ServiceContext, orgId: string, id: string) =>
  getStaff(ctx.env.DB, orgId, id);

type CreateStaff = z.infer<typeof CreateScanStaffSchema>;
type UpdateStaff = z.infer<typeof UpdateScanStaffSchema>;
type StaffDto = z.infer<typeof ScanStaffSchema>;
export type StaffAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

/** Staff writes answer a conflict on the same code the console already handles. */
const STAFF_CODES = { config: 'SCAN_STAFF_CHANGED', lineage: 'SCAN_STAFF_CHANGED' } as const;

function assertAuthority(
  authority: StaffAuthority,
  session: SessionAuth,
  orgId: string,
  mode: Mode,
  capability: 'scanning:read' | 'scanning:manage',
): void {
  if (
    authority.kind !== 'session' ||
    session.kind !== 'session' ||
    authority.orgId !== orgId ||
    authority.mode !== mode ||
    authority.capability !== capability ||
    session.userId !== authority.userId ||
    session.sessionId !== authority.sessionId ||
    session.mode !== authority.mode ||
    session.amr !== authority.amr ||
    session.roles.length !== authority.sessionRoles.length ||
    session.roles.some((role, index) => role !== authority.sessionRoles[index])
  )
    throw new ForbiddenError();
}

async function assertOrg(ctx: ServiceContext, orgId: string): Promise<void> {
  if (!(await orgIsActive(ctx.env.DB, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
}

function staffMutationError(error: unknown): never {
  const info = classifyD1Error(error);
  if (info?.kind === 'unique' && /scan_staff\.org_id|scan_staff_org_name/.test(info.detail))
    throw new ConflictError(
      'Another active staff member already has that name.',
      'STAFF_NAME_TAKEN',
    );
  throw error;
}

/**
 * The committed account, with its activity when that can be read. A mutation has already
 * committed, so a missing keyset or an unreadable activity never fails it: the plain account
 * answers, with no activity.
 */
async function committedStaff(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: StaffAuthority,
  id: string,
): Promise<StaffDto> {
  try {
    const result = await staffViews(ctx, session, authority, { staffId: id, limit: 1 });
    const [staff] = result.items;
    if (staff) return staff;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('scan.staff_activity_unavailable', { orgId: authority.orgId, code: error.code });
  }
  const base = await getStaffBase(ctx.env.DB, authority.orgId, id);
  if (!base) throw new NotFoundError('Staff member not found.', 'SCAN_STAFF_NOT_FOUND');
  return { ...base, locked: false, today: 0, lastScan: null };
}

/** Accounts and PINs are org-wide; the activity and lock status are for the console mode. */
export async function listStaff(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: StaffAuthority,
  orgId: string,
  mode: Mode,
  query: {
    q?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  } = {},
) {
  assertAuthority(authority, session, orgId, mode, 'scanning:read');
  const page: StaffPage = {
    q: query.q?.trim() || undefined,
    limit: Math.min(query.limit ?? STAFF_PAGE_LIMIT, STAFF_PAGE_MAX),
    cursor: decodeStaffCursor(query.cursor),
  };
  const result = await staffViews(ctx, session, authority, page);
  // `hasMore` and `nextCursor` are present only when there is more.
  const last = result.items.at(-1);
  return result.authorized
    ? {
        items: result.items,
        ...(result.hasMore && last ? { hasMore: true, nextCursor: encodeStaffCursor(last) } : {}),
      }
    : { items: [] };
}

export async function createStaff(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: StaffAuthority,
  mode: Mode,
  input: CreateStaff,
) {
  assertAuthority(authority, session, input.orgId, mode, 'scanning:manage');
  await assertOrg(ctx, input.orgId);
  const userId = authority.userId;
  const id = ctx.ids.id();
  const pin = await newUniquePin(ctx, input.orgId, id);
  const pinHash = await hashPin(ctx.env, id, pin);
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org.scan.staff.create',
    userId,
    authority,
    input.orgId,
    [],
    STAFF_CODES,
    id,
  );
  addStaffInsert(g, {
    id,
    name: input.name,
    role: input.role,
    pinHash,
    pinMacVersion: macKeyVersion(ctx.env),
    createdBy: userId,
    now,
  });
  g.add(
    audited(g, ctx, {
      orgId: input.orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scan_staff.create',
      targetType: 'scan_staff',
      targetId: id,
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    staffMutationError(error);
  }
  return { staff: await committedStaff(ctx, session, authority, id), pin };
}

export async function updateStaff(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: StaffAuthority,
  observed: ScanStaffRow,
  mode: Mode,
  input: UpdateStaff,
) {
  const { orgId, id } = observed;
  assertAuthority(authority, session, orgId, mode, 'scanning:manage');
  const userId = authority.userId;
  const now = ctx.clock.now();
  const action =
    input.disabled === true
      ? 'scan_staff.disable'
      : input.disabled === false
        ? 'scan_staff.enable'
        : 'scan_staff.update';
  const g = adminGrant(ctx, 'org.scan.staff.update', userId, authority, orgId, [], STAFF_CODES, id);
  addStaffUpdate(g, id, input, now);
  if (input.disabled === true) addUnbindStaffEverywhere(g, id, now);
  g.add(
    audited(g, ctx, {
      orgId,
      actorType: 'user',
      actorId: userId,
      action,
      targetType: 'scan_staff',
      targetId: id,
    }),
  );
  try {
    await g.commit();
  } catch (error) {
    staffMutationError(error);
  }
  return committedStaff(ctx, session, authority, id);
}

/**
 * The new PIN is returned only here; the stored credential is its staff-specific HMAC. The reset
 * signs the person out of every device in the same batch, so their next scan asks for the new PIN.
 * Session CSRF and the credential keyset are immutable and checked once at the request, not here.
 */
export async function resetStaffPin(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: StaffAuthority,
  staff: ScanStaffRow,
) {
  const { orgId, id } = staff;
  const { userId, mode } = authority;
  assertAuthority(authority, session, orgId, mode, 'scanning:manage');
  // Never the old PIN (under either root mid-rotation), and unique among the org's active staff.
  const pin = await newUniquePin(ctx, orgId, id, staff.pinHash);
  const pinHash = await hashPin(ctx.env, id, pin);
  const now = ctx.clock.now();
  const g = adminGrant(
    ctx,
    'org.scan.staff.pin_reset',
    userId,
    authority,
    orgId,
    staff.authEpoch === undefined ? [] : [epochIs('scan_staff', id, 'auth_epoch', staff.authEpoch)],
    STAFF_CODES,
    id,
  );
  addStaffPinRotate(g, id, pinHash, macKeyVersion(ctx.env), now);
  addUnbindStaffEverywhere(g, id, now);
  g.add(
    audited(g, ctx, {
      orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scan_staff.pin_reset',
      targetType: 'scan_staff',
      targetId: id,
    }),
  );
  await g.commit();
  return { pin };
}
