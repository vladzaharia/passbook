import type { SimulatePassInput, SimulatePassResponse } from '../../../shared/contracts/events.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvent } from '../events/record.ts';
import {
  eventStored,
  getSimulatedDevice,
  insertSimulatedDevice,
  latestCapturedOutbox,
  removeSimulatedDevice,
  simulatedDevicesOfPass,
} from '../events/repo-simulated.ts';
import { recordSimulatedScan } from '../scan/simulated.ts';
import type { Pass } from './repo-map.ts';
import type { Actor } from './service.ts';

/** The newest device that is still installed, or the one named. */
async function targetDevice(
  ctx: ServiceContext,
  pass: Pass,
  deviceId: string | undefined,
): Promise<string> {
  if (deviceId) {
    const row = await getSimulatedDevice(ctx.env.DB, deviceId, pass.id, pass.orgId);
    if (!row) throw new NotFoundError('Simulated device not found.', 'SIMULATE_DEVICE_NOT_FOUND');
    if (row.removed_at !== null)
      throw new ConflictError('That device is already removed.', 'SIMULATE_NO_DEVICE');
    return row.id;
  }
  const rows = await simulatedDevicesOfPass(ctx.env.DB, pass.id, pass.orgId);
  const live = rows.find((r) => r.removed_at === null);
  if (!live) throw new ConflictError('Simulate an install first.', 'SIMULATE_NO_DEVICE');
  return live.id;
}

/**
 * Sends one real Test event down the normal path: the ledger row, and from it the signed Test
 * webhooks. Test passes only; every credential gets the same 409 on a Live pass.
 */
export async function simulatePass(
  ctx: ServiceContext,
  actor: Actor,
  pass: Pass,
  input: SimulatePassInput,
): Promise<SimulatePassResponse> {
  if (pass.mode !== 'test')
    throw new ConflictError('Simulate works on Test passes only.', 'SIMULATE_TEST_ONLY');
  const requestId = ctx.requestId ?? ctx.ids.id();
  const id = ctx.ids.ordered(ctx.clock.now());
  const base = {
    id,
    orgId: pass.orgId,
    passId: pass.id,
    mode: pass.mode,
    actor,
  };
  const data = { simulated: true, requestId };
  let deviceId: string | undefined;

  switch (input.event) {
    case 'installed': {
      deviceId = ctx.ids.id();
      await insertSimulatedDevice(ctx.env.DB, {
        id: deviceId,
        orgId: pass.orgId,
        passId: pass.id,
        at: ctx.clock.now(),
      });
      await recordPassEvent(ctx, { ...base, kind: 'device.registered', device: deviceId, data });
      break;
    }
    case 'uninstalled': {
      deviceId = await targetDevice(ctx, pass, input.deviceId);
      await removeSimulatedDevice(ctx.env.DB, deviceId, pass.id, pass.orgId, ctx.clock.now());
      await recordPassEvent(ctx, {
        ...base,
        kind: 'device.unregistered',
        device: deviceId,
        data: { ...data, reason: 'wallet' },
      });
      break;
    }
    case 'scanned':
    case 'scan_refused':
      await recordSimulatedScan(ctx, {
        pass,
        id,
        requestId,
        actor,
        outcome: input.event === 'scanned' ? 'ok' : 'refused',
      });
      break;
    case 'push_failed': {
      deviceId = await targetDevice(ctx, pass, input.deviceId);
      await recordPassEvent(ctx, {
        ...base,
        kind: 'push.failed',
        device: deviceId,
        data: { ...data, version: pass.version, status: 410, reason: 'Unregistered' },
      });
      break;
    }
    case 'updated_on_device': {
      deviceId = await targetDevice(ctx, pass, input.deviceId);
      await recordPassEvent(ctx, {
        ...base,
        kind: 'device.fetched',
        device: deviceId,
        data: { ...data, step: 'file', version: pass.version, status: 200 },
      });
      break;
    }
    case 'email_failed': {
      const outboxId = await latestCapturedOutbox(ctx.env.DB, pass.id, pass.orgId);
      if (!outboxId)
        throw new ConflictError(
          'The Test inbox has no message for this pass.',
          'SIMULATE_NO_EMAIL',
        );
      await recordPassEvent(ctx, {
        ...base,
        kind: 'email.failed',
        data: { ...data, outboxId, attached: false, code: 'EMAIL_SIMULATED' },
      });
      break;
    }
  }

  // The ledger never throws, so a lost write is only visible here.
  if (!(await eventStored(ctx.env.DB, id)))
    throw new AppError('SIMULATE_FAILED', 500, 'The event was not recorded. Try again.');
  return { eventId: id, requestId, ...(input.event === 'installed' ? { deviceId } : {}) };
}
