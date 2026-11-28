import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { pushDevicePass } from './device-pass-push.ts';
import { endDevicePassesOfOrg } from './repo-device-pass.ts';

/** A sandbox closed or its developer lost access: its open device passes end and their phones are told. */
export async function endSandboxDevicePasses(ctx: ServiceContext, orgId: string): Promise<void> {
  const ended = await endDevicePassesOfOrg(ctx.env.DB, orgId, 'platform', ctx.clock.now());
  for (const row of ended) {
    await recordAudit(ctx, {
      orgId: row.org_id,
      actorType: 'system',
      actorId: null,
      action: 'device_pass.voided',
      targetType: 'device_pass',
      targetId: row.id,
      detail: { reason: 'sandbox_closed' },
    });
    ctx.waitUntil(pushDevicePass(ctx, row.id));
  }
}
