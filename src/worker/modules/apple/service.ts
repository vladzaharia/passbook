import { writeEvent } from '../../platform/analytics.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, BadRequestError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { redactString } from '../../platform/log.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { getPassBySerial } from '../passes/repo-read-pass.ts';
import { recordAppleEvents } from './events.ts';
import { attachLogLines } from './log-events.ts';
import {
  addRegistration,
  bumpLogCounter,
  currentSerials,
  GLOBAL_LOG_KEY,
  identityByPassType,
  insertLogs,
  registrationExists,
  removeRegistration,
  serialsSince,
  updatePushToken,
} from './repo.ts';
import { type AppleCredential, appleCredentialCurrent } from './repo-credential.ts';

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

const unauthorized = () => new UnauthenticatedError('Unauthorized.', 'APPLE_UNAUTHORIZED');

/** Recheck the exact credential immediately before releasing content or reporting success. */
export async function assertAppleCredential(
  ctx: ServiceContext,
  pass: AppleCredential,
): Promise<void> {
  if (!(await appleCredentialCurrent(ctx.env.DB, pass))) throw unauthorized();
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
  if (!identity || !pass || pass.testDataQuarantined || !ok) throw unauthorized();
  await assertAppleCredential(ctx, pass);
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
  if (await registrationExists(db, input.deviceId, pass)) {
    const updated = await updatePushToken(db, {
      deviceId: input.deviceId,
      pass,
      pushToken: input.pushToken,
    });
    if (updated) {
      await assertAppleCredential(ctx, pass);
      return 'existing';
    }
    // An ordinary concurrent unregister may have removed the row; a retired credential cannot retry it.
    await assertAppleCredential(ctx, pass);
  }
  const full = new AppError(
    'REGISTRATION_LIMIT',
    429,
    'This pass has too many registered devices.',
  );
  try {
    const created = await addRegistration(db, {
      deviceId: input.deviceId,
      pass,
      pushToken: input.pushToken,
      now,
    });
    if (!created) throw unauthorized();
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
    mode: pass.mode,
  });
  await recordAppleEvents(ctx, [
    {
      orgId: pass.orgId,
      passId: pass.id,
      mode: pass.mode,
      serial: pass.serial,
      credentialGeneration: pass.credentialGeneration,
      kind: 'device.registered',
      device: input.deviceId,
    },
  ]);
  await assertAppleCredential(ctx, pass);
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
  const removed = await removeRegistration(ctx.env.DB, input.deviceId, pass);
  if (removed === 'stale') throw unauthorized();
  if (removed === 'removed') {
    writeEvent(ctx.env, {
      event: 'pass.unregistered',
      orgId: pass.orgId,
      templateId: pass.templateId,
      identityId: identity.id,
      mode: pass.mode,
    });
    await recordAppleEvents(ctx, [
      {
        orgId: pass.orgId,
        passId: pass.id,
        mode: pass.mode,
        serial: pass.serial,
        credentialGeneration: pass.credentialGeneration,
        kind: 'device.unregistered',
        device: input.deviceId,
        data: { reason: 'device' },
      },
    ]);
  }
  await assertAppleCredential(ctx, pass);
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
  if (rows.length === 0) return null;
  await recordAppleEvents(
    ctx,
    rows.map((r) => ({
      orgId: r.orgId,
      passId: r.passId,
      mode: r.mode,
      serial: r.serial,
      credentialGeneration: r.credentialGeneration,
      kind: 'device.fetched' as const,
      device: input.deviceId,
      data: { step: 'listed', version: r.version },
    })),
  );
  const confirmed = await currentSerials(ctx.env.DB, input.deviceId, identity.id, rows);
  const last = confirmed.at(-1);
  return last
    ? { serialNumbers: confirmed.map((r) => r.serial), lastUpdated: String(last.revision) }
    : null;
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
  // Attaching is best effort: a failure must not turn Wallet's log post into a 500.
  await attachLogLines(ctx, kept).catch((error: unknown) =>
    ctx.log.warn('events.log_attach_failed', { code: 'EVENT_LOG_ATTACH', error }),
  );
  return kept.length;
}
