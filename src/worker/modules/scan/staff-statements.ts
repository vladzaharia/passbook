import type { z } from 'zod';
import type { CreateScanStaffSchema } from '../../../shared/contracts/scanners.ts';
import type { Grant } from '../../platform/authority.ts';
import { macKeyVersion } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { adminActorOf, audited, createdByOf } from './repo-admin-grant.ts';
import { addStaffInsert } from './repo-staff.ts';
import type { SetupCapture } from './setup-capture.ts';
import { hashPin } from './staff-pin.ts';

export type CreateStaff = z.infer<typeof CreateScanStaffSchema>;

/** Staff writes answer a conflict on the same code the console already handles. */
export const STAFF_CODES = { config: 'SCAN_STAFF_CHANGED', lineage: 'SCAN_STAFF_CHANGED' } as const;

export function staffMutationError(error: unknown): never {
  const info = classifyD1Error(error);
  if (info?.kind === 'unique' && /scan_staff\.org_id|scan_staff_org_name/.test(info.detail))
    throw new ConflictError(
      'Another active staff member already has that name.',
      'STAFF_NAME_TAKEN',
    );
  throw error;
}

export interface StaffPlan {
  input: CreateStaff;
  id: string;
  /** Shown once: only its hash is stored. */
  pin: string;
  pinHash: string;
}

/** The reads of a staff create: the org is active, then the PIN and its hash. Nothing is written. */
export async function planStaff(ctx: ServiceContext, input: CreateStaff): Promise<StaffPlan> {
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const id = ctx.ids.id();
  const pin = ctx.ids.code(6);
  return { input, id, pin, pinHash: await hashPin(ctx.env, id, pin) };
}

/** The staff row and its audit row. The PIN goes back to the caller and nowhere else. */
export function staffStatements(
  g: Grant,
  ctx: ServiceContext,
  plan: StaffPlan,
  capture: SetupCapture,
): { id: string; pin: string } {
  const { input, id, pin, pinHash } = plan;
  addStaffInsert(g, {
    id,
    name: input.name,
    role: input.role,
    pinHash,
    pinMacVersion: macKeyVersion(ctx.env),
    createdBy: createdByOf(capture.authority, capture.userId),
    now: ctx.clock.now(),
  });
  g.add(
    audited(g, ctx, {
      orgId: input.orgId,
      ...adminActorOf(capture.authority, capture.userId),
      action: 'scan_staff.create',
      targetType: 'scan_staff',
      targetId: id,
    }),
  );
  return { id, pin };
}
