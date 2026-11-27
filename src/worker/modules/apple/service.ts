import { writeEvent } from '../../platform/analytics.ts';
import { MAC_PREFIX, tokenMatches } from '../../platform/capability-token.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  AppError,
  BadRequestError,
  RateLimitedError,
  UnauthenticatedError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ipRatePrefix } from '../../platform/ip.ts';
import { redactString } from '../../platform/log.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordCopy } from '../channels/gate.ts';
import { armOnRegister } from '../passes/identity-move.ts';
import type { Pass } from '../passes/repo.ts';
import { getPassBySerial } from '../passes/repo-read-pass.ts';
import { recordAppleEvents } from './events.ts';
import { attachLogLines } from './log-events.ts';
import {
  addRegistration,
  currentSerials,
  identityByPassType,
  registrationExists,
  registrationsSince,
  removeRegistration,
  serialsSince,
  updatePushToken,
} from './repo.ts';
import { type AppleCredential, appleCredentialCurrent } from './repo-credential.ts';
import { bumpLogCounter, GLOBAL_LOG_KEY, insertLogs } from './repo-logs.ts';

const MAX_SERIALS = 200;
const MAX_LOG_LINES = 100;
const MAX_LOG_LINE = 1000;
/** Soft global ceiling: past it only quiet prefixes still log. */
const LOG_LINES_PER_HOUR = 5000;
/** Hard global ceiling: past it nobody logs, so rotating addresses cannot grow wallet_logs unbounded. */
const LOG_LINES_HARD_PER_HOUR = 2 * LOG_LINES_PER_HOUR;
/** Per /24 (v4) or /64 (v6) and hour. Counted in lines but sized for several full 100-line posts. */
const LOG_LINES_PER_PREFIX_HOUR = 500;
/** Past the soft ceiling, a prefix that has spent this much of its hour is shed. */
const LOG_LINES_RESERVED_PER_PREFIX = 100;
const HOUR = 3_600_000;
/** New devices one pass may register per hour; the RL bindings only count per minute. */
const NEW_REGISTRATIONS_PER_HOUR = 5;

export const DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** APNs device tokens vary in length; APNs rejects bad ones (BadDeviceToken cleans them up). */
export const PUSH_TOKEN = /^(?:[0-9a-fA-F]{2}){8,200}$/;
/** Compared when the pass is unknown so the response time does not reveal which part was wrong. */
const DUMMY_STORED = `${MAC_PREFIX}${'0'.repeat(64)}`;
const SCHEME = 'ApplePass ';

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
  const presented = authorization?.startsWith(SCHEME) ? authorization.slice(SCHEME.length) : '';
  const ok = await tokenMatches(
    ctx.env,
    'apple-auth',
    pass ? pass.authToken : DUMMY_STORED,
    presented,
  );
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
  // A bearer cannot push the real holder's devices out: past the cap a new device is refused.
  if ((await registrationsSince(db, pass.id, now - HOUR)) >= NEW_REGISTRATIONS_PER_HOUR) {
    ctx.log.warn('apple.registration_throttled', {
      code: 'REGISTRATION_THROTTLED',
      orgId: pass.orgId,
      passId: pass.id,
    });
    throw new RateLimitedError(3600);
  }
  try {
    const created = await addRegistration(db, {
      deviceId: input.deviceId,
      pass,
      pushToken: input.pushToken,
      now,
    });
    if (!created) throw unauthorized();
  } catch (error) {
    // The pass is at the cap: the trigger aborts the batch.
    if (classifyD1Error(error)?.kind === 'abort') {
      ctx.log.warn('apple.registration_cap', {
        code: 'REGISTRATION_LIMIT',
        orgId: pass.orgId,
        passId: pass.id,
      });
      throw full;
    }
    throw error;
  }
  await recordCopy(ctx, pass, 'apple');
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
  // A replacement from an identity move starts its old pass's 24 hours. The sweep arms it if this fails.
  await armOnRegister(ctx, pass.id).catch((error: unknown) =>
    ctx.log.error('apple.move_arm_failed', { code: 'IDENTITY_MOVE_ARM', passId: pass.id, error }),
  );
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
 * Stores redacted, truncated lines. /log carries no credential (Apple's protocol), so each client
 * network prefix (/24, /64) has its own hourly budget; fresh addresses inside one prefix share it.
 * A soft global ceiling sheds only prefixes already past a small reserve, so a few noisy networks
 * cannot lock every device out; a hard ceiling behind it admits no one.
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
  const prefixKey = `apple.log.ip:${(await sha256Hex(ipRatePrefix(ip) ?? 'unknown')).slice(0, 16)}`;
  const own = await bumpLogCounter(ctx.env.DB, prefixKey, window, kept.length);
  const budget = () => new AppError('LOG_BUDGET', 429, 'Too many log lines. Try again later.');
  if (own > LOG_LINES_PER_PREFIX_HOUR) throw budget();
  const total = await bumpLogCounter(ctx.env.DB, GLOBAL_LOG_KEY, window, kept.length);
  if (
    total > LOG_LINES_HARD_PER_HOUR ||
    (total > LOG_LINES_PER_HOUR && own > LOG_LINES_RESERVED_PER_PREFIX)
  ) {
    ctx.log.warn('apple.log_shed', { code: 'LOG_BUDGET' });
    throw budget();
  }
  await insertLogs(ctx.env.DB, kept, null, now);
  // Attaching is best effort: a failure must not turn Wallet's log post into a 500.
  await attachLogLines(ctx, kept).catch((error: unknown) =>
    ctx.log.warn('events.log_attach_failed', { code: 'EVENT_LOG_ATTACH', error }),
  );
  return kept.length;
}
