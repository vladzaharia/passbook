import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { adminGrant, audited } from './repo-admin-grant.ts';
import { clearNamedDayStatement } from './repo-pin-tag.ts';
import { untaggedCountStatement, untaggedFlagUpdate } from './repo-pin-untagged.ts';
import type { ScanStaffRow } from './repo-staff.ts';
import { STAFF_CODES } from './staff-statements.ts';

type StaffAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

/** Unlock: the person's wrong PINs of the day stop counting. Audited. */
export async function unlockStaffPin(
  ctx: ServiceContext,
  authority: StaffAuthority,
  staff: ScanStaffRow,
): Promise<void> {
  const db = ctx.env.DB;
  await db.batch([
    clearNamedDayStatement(db, staff.id),
    auditStmt(db, ctx, {
      orgId: staff.orgId,
      actorType: 'user',
      actorId: authority.userId,
      action: 'scan_staff.pin_unlock',
      targetType: 'scan_staff',
      targetId: staff.id,
    }),
  ]);
}

/**
 * Flags every active Door and Desk person whose PIN has no tag yet (they never signed in since tags came): their
 * next sign-in by name sets each a new PIN, and a duplicate among old PINs ends. No automatic cutoff.
 */
export async function resetUntaggedPins(
  ctx: ServiceContext,
  authority: StaffAuthority,
  orgId: string,
): Promise<{ flagged: number }> {
  const before = await first<{ n: number }>(ctx.env.DB, ...untaggedCountStatement(orgId));
  const g = adminGrant(
    ctx,
    'org.scan.staff.reset_untagged',
    authority.userId,
    authority,
    orgId,
    [],
    STAFF_CODES,
    orgId,
  );
  untaggedFlagUpdate(g);
  g.add(
    audited(g, ctx, {
      orgId,
      actorType: 'user',
      actorId: authority.userId,
      action: 'scan_staff.reset_untagged',
      targetType: 'org',
      targetId: orgId,
    }),
  );
  await g.commit();
  return { flagged: before?.n ?? 0 };
}
