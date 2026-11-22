import type { z } from 'zod';
import type { ScanStaffSchema, UpdateScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { credentialKeyOf } from './key-credentials.ts';
import { adminGrant } from './repo-admin-grant.ts';
import { getStaffBase, type ScanStaffRow, type StaffBase } from './repo-staff.ts';
import { listStaffAccounts } from './repo-staff-accounts.ts';
import {
  decodeStaffCursor,
  encodeStaffCursor,
  STAFF_PAGE_LIMIT,
  STAFF_PAGE_MAX,
} from './repo-staff-page.ts';
import { newCapture } from './setup-capture.ts';
import { commitPinReset, commitStaffUpdate } from './staff-admin-writes.ts';
import {
  type CreateStaff,
  planStaff,
  STAFF_CODES,
  staffMutationError,
  staffStatements,
} from './staff-statements.ts';

type StaffDto = z.infer<typeof ScanStaffSchema>;

/** The plain account: a key reads no activity, so the committed fallback shape is the answer. */
const plain = (b: StaffBase): StaffDto => ({
  ...b,
  pinLockedToday: false,
  locked: false,
  today: 0,
  lastScan: null,
});

async function account(ctx: ServiceContext, orgId: string, id: string): Promise<StaffDto> {
  const base = await getStaffBase(ctx.env.DB, orgId, id);
  if (!base) throw new NotFoundError('Staff member not found.', 'SCAN_STAFF_NOT_FOUND');
  return plain(base);
}

/** The staff of the key's org, without activity or locks. Staff belong to the org, not a mode. */
export async function listStaffByKey(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  actorId: string,
  orgId: string,
  query: { q?: string | undefined; limit?: number | undefined; cursor?: string | undefined },
) {
  credentialKeyOf(authority, orgId, actorId, 'scanning:admin');
  const limit = Math.min(query.limit ?? STAFF_PAGE_LIMIT, STAFF_PAGE_MAX);
  const rows = await listStaffAccounts(ctx.env.DB, orgId, {
    q: query.q?.trim() || undefined,
    limit,
    cursor: decodeStaffCursor(query.cursor),
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(plain),
    ...(rows.length > limit && last ? { hasMore: true, nextCursor: encodeStaffCursor(last) } : {}),
  };
}

export async function createStaffByKey(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  actorId: string,
  input: CreateStaff,
  ip: string | null,
  committed: () => void = () => {},
) {
  const key = credentialKeyOf(authority, input.orgId, actorId, 'scanning:admin');
  const capture = newCapture({
    userId: actorId,
    authority: key,
    orgId: input.orgId,
    mode: 'live',
    ip,
  });
  const plan = await planStaff(ctx, input);
  const g = adminGrant(
    ctx,
    'org.scan.staff.create',
    actorId,
    key,
    input.orgId,
    [],
    STAFF_CODES,
    plan.id,
  );
  const { id, pin } = staffStatements(g, ctx, plan, capture);
  try {
    await g.commit();
  } catch (error) {
    staffMutationError(error);
  }
  committed();
  return { staff: await account(ctx, input.orgId, id), pin };
}

export async function updateStaffByKey(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  actorId: string,
  observed: ScanStaffRow,
  input: z.infer<typeof UpdateScanStaffSchema>,
  ip: string | null,
) {
  const key = credentialKeyOf(authority, observed.orgId, actorId, 'scanning:admin');
  await commitStaffUpdate(ctx, actorId, key, observed, input, ip);
  return account(ctx, observed.orgId, observed.id);
}

export async function resetStaffPinByKey(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  actorId: string,
  staff: ScanStaffRow,
  ip: string | null,
  committed: () => void = () => {},
) {
  const key = credentialKeyOf(authority, staff.orgId, actorId, 'scanning:admin');
  return { pin: await commitPinReset(ctx, actorId, key, staff, ip, committed) };
}
