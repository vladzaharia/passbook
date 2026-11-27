import type { SessionAuth } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { pushDevicePass } from './device-pass-push.ts';
import { endDevicePassesOf } from './repo-device-pass.ts';
import { unblockUser } from './repo-device-pass-devices.ts';

/** Platform kill switch for one developer: every open device pass ends and its phones are told. */
export async function voidAllOf(
  ctx: ServiceContext,
  admin: SessionAuth,
  userId: string,
): Promise<number> {
  const ended = await endDevicePassesOf(ctx.env.DB, userId, 'platform', ctx.clock.now());
  for (const row of ended) {
    await recordAudit(ctx, {
      orgId: row.org_id,
      actorType: 'user',
      actorId: admin.userId,
      action: 'device_pass.voided',
      targetType: 'device_pass',
      targetId: row.id,
      detail: { reason: 'platform' },
    });
    ctx.waitUntil(pushDevicePass(ctx, row.id));
  }
  return ended.length;
}

/** Clears the block an over-shared pass left, so the developer can make device passes again. */
export async function clearBlock(
  ctx: ServiceContext,
  admin: SessionAuth,
  userId: string,
): Promise<boolean> {
  const cleared = await unblockUser(ctx.env.DB, userId);
  if (cleared)
    await recordAudit(ctx, {
      orgId: null,
      actorType: 'user',
      actorId: admin.userId,
      action: 'device_pass.unblocked',
      targetType: 'user',
      targetId: userId,
      detail: {},
    });
  return cleared;
}
