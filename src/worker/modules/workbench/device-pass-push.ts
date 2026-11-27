import type { Json } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { classifyApns } from '../delivery/push.ts';
import { type PassEventInput, recordPassEvents } from '../events/record.ts';
import { depsOf } from '../passes/deps.ts';
import { deviceTestIdentity } from './device-pass-identity.ts';
import { getDevicePass } from './repo-device-pass.ts';
import { devicesOf, removeDevice } from './repo-device-pass-devices.ts';

/** What a device pass event says on the source pass: it came from a developer's own phone, not a real holder. */
export const deviceEvent = (
  row: { id: string; org_id: string; pass_id: string },
  kind: PassEventInput['kind'],
  device: string | null,
  data: Record<string, Json> = {},
): PassEventInput => ({
  orgId: row.org_id,
  passId: row.pass_id,
  mode: 'test',
  kind,
  device,
  data: { devicePass: true, platform: 'apple', devicePassId: row.id, ...data },
});

/**
 * Tells the phones of one device pass to fetch it again (a new version, a void, an expiry). A failure reaches
 * the source pass's stream as `push.failed` (and a gone phone as `device.unregistered`); it never throws, so the
 * change that caused the push is not undone by it.
 * @absorbs It answers nothing: no code of what it calls reaches a route.
 */
export async function pushDevicePass(ctx: ServiceContext, id: string): Promise<void> {
  try {
    const row = await getDevicePass(ctx.env.DB, id);
    if (!row) return;
    const devices = await devicesOf(ctx.env.DB, id);
    if (devices.length === 0) return;
    const identity = await deviceTestIdentity(ctx);
    const target = {
      passTypeIdentifier: identity.passTypeIdentifier,
      apnsBinding: identity.apnsBinding,
      teamIdentifier: identity.teamIdentifier,
    };
    const apns = depsOf(ctx.env).apns;
    const events: PassEventInput[] = [];
    if (!(await apns.isAvailable(target))) {
      for (const device of devices)
        events.push(
          deviceEvent(row, 'push.failed', device.device_id, {
            code: 'PUSH_UNAVAILABLE',
            version: row.source_version,
          }),
        );
      await recordPassEvents(ctx, events);
      return;
    }
    const results = await apns.send(
      target,
      [...new Set(devices.map((d) => d.push_token))],
      ctx.clock.now(),
    );
    for (const result of results)
      for (const device of devices.filter((d) => d.push_token === result.token)) {
        const outcome = classifyApns(result);
        const data = {
          version: row.source_version,
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
          outcome,
        };
        events.push(
          deviceEvent(row, outcome === 'ok' ? 'push.sent' : 'push.failed', device.device_id, data),
        );
        if (
          outcome === 'gone' &&
          (await removeDevice(ctx.env.DB, id, device.device_id, ctx.clock.now()))
        )
          events.push(
            deviceEvent(row, 'device.unregistered', device.device_id, { reason: 'push_gone' }),
          );
      }
    await recordPassEvents(ctx, events);
  } catch (error) {
    ctx.log.error('device_pass.push_failed', {
      code: 'DEVICE_PASS_PUSH_FAILED',
      devicePassId: id,
      error,
    });
  }
}
