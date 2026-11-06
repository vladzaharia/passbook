import type { z } from 'zod';
import type { ScanApprovalSchema } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { getStaff } from './repo-staff.ts';
import { checkPin } from './staff-pin.ts';

/**
 * A Manager's PIN for one action (SA 2.7). Verified here and stored nowhere: the scan row keeps
 * only `approved_by`. A PIN that is right but belongs to a Door or Desk person is a plain miss.
 */
export async function verifyApproval(
  ctx: ServiceContext,
  actor: ScanActor,
  approval: z.infer<typeof ScanApprovalSchema>,
): Promise<string> {
  const staff = await getStaff(ctx.env.DB, actor.orgId, approval.staffId);
  await checkPin(ctx, {
    scannerId: actor.scanner?.id ?? actor.actorKey,
    orgId: actor.orgId,
    staffId: approval.staffId,
    staff: staff?.role === 'manager' ? staff : null,
    pin: approval.pin,
  });
  return approval.staffId;
}
