import { DEVICE_PASS_MAX_DEVICES } from '../../../shared/contracts/device-passes.ts';
import { BadRequestError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { DEVICE_ID, PUSH_TOKEN } from '../apple/service.ts';
import { recordAudit } from '../audit/service.ts';
import { recordPassEvent } from '../events/record.ts';
import { PLATFORM_SLOTS } from '../identities/provision-platform.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { buildDevicePass } from './device-pass-build.ts';
import { devicePassEnabled, deviceTestIdentity } from './device-pass-identity.ts';
import { deviceEvent, pushDevicePass } from './device-pass-push.ts';
import { devicePassIdOf, tokenIsValid } from './device-pass-token.ts';
import {
  type DevicePassRow,
  endDevicePass,
  getDevicePass,
  markServed,
  touchSeen,
} from './repo-device-pass.ts';
import { addDevice, blockUser, changedSince, removeDevice } from './repo-device-pass-devices.ts';

const SCHEME = 'ApplePass ';
const MAX_SERIALS = 200;

/** Wallet's web service reaches device passes by this pass type and the `dp_` serial prefix. */
export const isDeviceTestPassType = (passTypeId: string): boolean =>
  passTypeId === PLATFORM_SLOTS.devtest.passType;

const unauthorized = () => new UnauthenticatedError('Unauthorized.', 'APPLE_UNAUTHORIZED');

/** The device pass a request is for, proved by its token. Every refusal is the same 401: nothing says why. */
async function authorize(
  ctx: ServiceContext,
  passTypeId: string,
  serial: string,
  authorization: string | undefined,
): Promise<DevicePassRow> {
  const id = devicePassIdOf(serial);
  const row = id && devicePassEnabled(ctx.env) ? await getDevicePass(ctx.env.DB, id) : null;
  const presented = authorization?.startsWith(SCHEME) ? authorization.slice(SCHEME.length) : '';
  const ok = await tokenIsValid(ctx.env, row, presented);
  if (!row || !ok || !isDeviceTestPassType(passTypeId)) throw unauthorized();
  return row;
}

const checkDevice = (deviceId: string): void => {
  if (!DEVICE_ID.test(deviceId)) throw new BadRequestError('Invalid device id.', 'DEVICE_INVALID');
};

/**
 * More than 3 distinct phones: the pass ends at once (the phones it already has get the voided copy), the
 * developer cannot make another until a platform admin clears the block, and the fourth phone is refused.
 */
async function overshare(ctx: ServiceContext, row: DevicePassRow): Promise<never> {
  const ended = await endDevicePass(ctx.env.DB, row.id, 'overshared', ctx.clock.now());
  await blockUser(ctx.env.DB, row.user_id, ctx.clock.now());
  if (ended) {
    const system = { type: 'system', id: null } as const;
    for (const action of ['overshared', 'voided'])
      await recordAudit(ctx, {
        orgId: row.org_id,
        actorType: system.type,
        actorId: system.id,
        action: `device_pass.${action}`,
        targetType: 'device_pass',
        targetId: row.id,
        detail: { reason: 'overshared', limit: DEVICE_PASS_MAX_DEVICES },
      });
    ctx.waitUntil(pushDevicePass(ctx, row.id));
  }
  throw unauthorized();
}

export async function registerDevicePass(
  ctx: ServiceContext,
  input: {
    deviceId: string;
    passTypeId: string;
    serial: string;
    authorization: string | undefined;
    pushToken: unknown;
  },
): Promise<'created' | 'existing'> {
  const row = await authorize(ctx, input.passTypeId, input.serial, input.authorization);
  checkDevice(input.deviceId);
  if (typeof input.pushToken !== 'string' || !PUSH_TOKEN.test(input.pushToken))
    throw new BadRequestError('Invalid push token.', 'PUSH_TOKEN_INVALID');
  // An ended pass takes no new phone; one that is not downloaded yet cannot have been added.
  if (row.state !== 'active' || row.expires_at <= ctx.clock.now()) throw unauthorized();
  const now = ctx.clock.now();
  const added = await addDevice(ctx.env.DB, {
    devicePassId: row.id,
    deviceId: input.deviceId,
    pushToken: input.pushToken,
    now,
    max: DEVICE_PASS_MAX_DEVICES,
  });
  if (added === 'over') return overshare(ctx, row);
  if (added === 'known') return 'existing';
  await recordPassEvent(ctx, deviceEvent(row, 'device.registered', input.deviceId));
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: 'device',
    actorId: null,
    action: 'device_pass.installed',
    targetType: 'device_pass',
    targetId: row.id,
    detail: {},
  });
  await touchSeen(ctx.env.DB, row.id, now);
  return 'created';
}

export async function unregisterDevicePass(
  ctx: ServiceContext,
  input: {
    deviceId: string;
    passTypeId: string;
    serial: string;
    authorization: string | undefined;
  },
): Promise<void> {
  const row = await authorize(ctx, input.passTypeId, input.serial, input.authorization);
  checkDevice(input.deviceId);
  if (await removeDevice(ctx.env.DB, row.id, input.deviceId))
    await recordPassEvent(
      ctx,
      deviceEvent(row, 'device.unregistered', input.deviceId, { reason: 'device' }),
    );
}

/** Unauthenticated by protocol, like the real one: keyed by the opaque device id. */
export async function updatedDevicePasses(
  ctx: ServiceContext,
  input: { deviceId: string; since: string | undefined },
): Promise<{ serialNumbers: string[]; lastUpdated: string } | null> {
  checkDevice(input.deviceId);
  if (input.since !== undefined && !/^\d{1,15}$/.test(input.since))
    throw new BadRequestError('Invalid update tag.', 'TAG_INVALID');
  if (!devicePassEnabled(ctx.env)) return null;
  const rows = await changedSince(
    ctx.env.DB,
    input.deviceId,
    Number(input.since ?? '0'),
    MAX_SERIALS,
  );
  const last = rows.at(-1);
  return last
    ? { serialNumbers: rows.map((r) => `dp_${r.id}`), lastUpdated: String(last.updated_at) }
    : null;
}

const second = (ms: number) => Math.floor(ms / 1000);

/** The latest device pass for a phone: the live copy, or the voided one once it ended. A 304 when the phone has it. */
export async function serveDevicePass(
  ctx: ServiceContext,
  input: { passTypeId: string; serial: string; authorization: string | undefined },
  request: Request,
): Promise<Response> {
  const row = await authorize(ctx, input.passTypeId, input.serial, input.authorization);
  const headers = new Headers({
    'last-modified': new Date(second(row.updated_at) * 1000).toUTCString(),
    etag: `"dp-${row.updated_at}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  const noneMatch = request.headers.get('if-none-match');
  const since = Date.parse(request.headers.get('if-modified-since') ?? '');
  if (
    noneMatch
      ? noneMatch.includes(`"dp-${row.updated_at}"`)
      : second(row.updated_at) <= second(since)
  )
    return new Response(null, { status: 304, headers });
  const source = await getPass(ctx.env.DB, row.pass_id);
  if (!source) throw unauthorized();
  const built = await buildDevicePass(ctx, row, source, await deviceTestIdentity(ctx));
  const now = ctx.clock.now();
  await markServed(ctx.env.DB, row.id, now, built.hash);
  headers.set('content-type', 'application/vnd.apple.pkpass');
  return new Response(built.bytes as BodyInit, { headers });
}
