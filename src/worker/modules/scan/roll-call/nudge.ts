import type { Mode } from '../../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { scanHub } from '../live.ts';
import type { CallRow } from './repo.ts';

/** A hub that cannot be reached is a device that was not told: the next read or poll finds the change. */
export async function nudgeDevices(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  call: Pick<CallRow, 'id' | 'rev' | 'endedAt'>,
): Promise<void> {
  try {
    const rollCall = { id: call.id, rev: call.rev, ended: call.endedAt !== null };
    await scanHub(ctx, orgId, mode).toDevice(
      { orgId, mode, now: ctx.clock.now() },
      { rollCall },
      false,
    );
  } catch {
    ctx.log.warn('scan.roll_call.nudge_failed', { orgId, code: 'ROLL_CALL_NUDGE_FAILED' });
  }
}
