import { writeEvent } from '../../platform/analytics.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, BadRequestError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { redactString } from '../../platform/log.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { getPassBySerial, type Pass } from '../passes/repo.ts';
import {
  addRegistration,
  bumpLogCounter,
  GLOBAL_LOG_KEY,
  identityByPassType,
  insertLogs,
  registrationCount,
  registrationExists,
  removeRegistration,
  serialsSince,
  updatePushToken,
} from './repo.ts';

export const MAX_REGISTRATIONS_PER_PASS = 20;
const MAX_SERIALS = 200;
const MAX_LOG_LINES = 100;
const MAX_LOG_LINE = 1000;
const LOG_LINES_PER_HOUR = 5000;
const LOG_LINES_PER_IP_HOUR = 300;
const HOUR = 3_600_000;

const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** APNs device tokens vary in length; APNs rejects bad ones (BadDeviceToken cleans them up). */
const PUSH_TOKEN = /^(?:[0-9a-fA-F]{2}){8,200}$/;
/** Compared when the pass is unknown so the response time does not reveal which part was wrong. */
const DUMMY_TOKEN = 'ApplePass 0000000000000000000000000000000000000000000';

export interface AppleTarget {
  pass: Pass;
  identity: { id: string; nfcEnabled: boolean };
}

/** `Authorization: ApplePass <token>` against the pass looked up by (identity, serial). */
export async function authorizePass(
  ctx: ServiceContext,
  passTypeId: string,
  serial: string,
  authorization: string | undefined,
): Promise<AppleTarget> {
  const identity = await identityByPassType(ctx.env.DB, passTypeId);
  const pass = identity ? await getPassBySerial(ctx.env.DB, identity.id, serial) : null;
  const expected = pass ? `ApplePass ${pass.authToken}` : DUMMY_TOKEN;
  const ok = await safeEqual(authorization ?? '', expected);
  // A suspended or deleted org reads as an unknown pass.
  const active = pass ? await isOrgActive(ctx, pass.orgId) : false;
  if (!identity || !pass || !ok || !active)
    throw new UnauthenticatedError('Unauthorized.', 'APPLE_UNAUTHORIZED');
  return { pass, identity };
}

function checkDevice(deviceId: string): void {
  if (!DEVICE_ID.test(deviceId)) throw new BadRequestError('Invalid device id.', 'DEVICE_INVALID');
}

export async function registerDevice(
  ctx: ServiceContext,
  input: {
    deviceId: string;
    passTypeId: string;
    serial: string;
    authorization: string | undefined;
    pushToken: unknown;
  },
): Promise<'created' | 'existing'> {
  const { pass, identity } = await authorizePass(
    ctx,
    input.passTypeId,
    input.serial,
    input.authorization,
  );
  checkDevice(input.deviceId);
  if (typeof input.pushToken !== 'string' || !PUSH_TOKEN.test(input.pushToken))
    throw new BadRequestError('Invalid push token.', 'PUSH_TOKEN_INVALID');
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  if (await registrationExists(db, input.deviceId, identity.id, pass.id)) {
    await updatePushToken(db, {
      deviceId: input.deviceId,
      identityId: identity.id,
      passId: pass.id,
      pushToken: input.pushToken,
      now,
    });
    return 'existing';
  }
  const full = new AppError(
    'REGISTRATION_LIMIT',
    429,
    'This pass has too many registered devices.',
  );
  if ((await registrationCount(db, pass.id)) >= MAX_REGISTRATIONS_PER_PASS) throw full;
  try {
    await addRegistration(db, {
      deviceId: input.deviceId,
      identityId: identity.id,
      passId: pass.id,
      pushToken: input.pushToken,
      now,
    });
  } catch (error) {
    // Lost the race for the last slot: the trigger aborts the batch.
    if (classifyD1Error(error)?.kind === 'abort') throw full;
    throw error;
  }
  writeEvent(ctx.env, {
    event: 'pass.registered',
    orgId: pass.orgId,
    templateId: pass.templateId,
    identityId: identity.id,
  });
  return 'created';
}

export async function unregisterDevice(
  ctx: ServiceContext,
  input: {
    deviceId: string;
    passTypeId: string;
    serial: string;
    authorization: string | undefined;
  },
): Promise<void> {
  const { pass, identity } = await authorizePass(
    ctx,
    input.passTypeId,
    input.serial,
    input.authorization,
  );
  checkDevice(input.deviceId);
  const removed = await removeRegistration(ctx.env.DB, input.deviceId, identity.id, pass.id);
  if (removed)
    writeEvent(ctx.env, {
      event: 'pass.unregistered',
      orgId: pass.orgId,
      templateId: pass.templateId,
      identityId: identity.id,
    });
}

/** Unauthenticated by protocol: keyed by the opaque device id. Unknown pass types read as empty. */
export async function updatedSerials(
  ctx: ServiceContext,
  input: { deviceId: string; passTypeId: string; since: string | undefined },
): Promise<{ serialNumbers: string[]; lastUpdated: string } | null> {
  checkDevice(input.deviceId);
  if (input.since !== undefined && !/^\d{1,15}$/.test(input.since))
    throw new BadRequestError('Invalid update tag.', 'TAG_INVALID');
  const identity = await identityByPassType(ctx.env.DB, input.passTypeId);
  if (!identity) return null;
  const rows = await serialsSince(
    ctx.env.DB,
    input.deviceId,
    identity.id,
    Number(input.since ?? '0'),
    MAX_SERIALS,
  );
  const last = rows.at(-1);
  if (!last) return null;
  return { serialNumbers: rows.map((r) => r.serial), lastUpdated: String(last.revision) };
}

const clean = (line: string) =>
  Array.from(line, (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('');

/**
 * Stores redacted, truncated lines. Each client IP has its own hourly budget, with a global
 * ceiling behind it; over either, the lines are dropped and 429 returned.
 */
export async function recordDeviceLogs(
  ctx: ServiceContext,
  lines: string[],
  ip: string,
): Promise<number> {
  const kept = lines
    .slice(0, MAX_LOG_LINES)
    .map((line) => redactString(clean(line)).slice(0, MAX_LOG_LINE));
  if (kept.length === 0) return 0;
  const now = ctx.clock.now();
  const window = Math.floor(now / HOUR) * HOUR;
  const ipKey = `apple.log.ip:${(await sha256Hex(ip)).slice(0, 16)}`;
  if ((await bumpLogCounter(ctx.env.DB, ipKey, window, kept.length)) > LOG_LINES_PER_IP_HOUR)
    throw new AppError('LOG_BUDGET', 429, 'Too many log lines. Try again later.');
  const total = await bumpLogCounter(ctx.env.DB, GLOBAL_LOG_KEY, window, kept.length);
  if (total > LOG_LINES_PER_HOUR)
    throw new AppError('LOG_BUDGET', 429, 'Too many log lines. Try again later.');
  await insertLogs(ctx.env.DB, kept, null, now);
  return kept.length;
}
