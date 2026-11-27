import {
  DEVICE_PASS_CODE_TTL_MS,
  DEVICE_PASS_MAX_ACTIVE,
  DEVICE_PASS_PER_HOUR,
  DEVICE_PASS_TTL_MS,
  type DevicePassDto,
} from '../../../shared/contracts/device-passes.ts';
import {
  DEVICE_PASS_BLOCKED_COPY,
  DEVICE_PASS_CODE_LIMIT_COPY,
  DEVICE_PASS_CODE_USED_COPY,
  DEVICE_PASS_LIMIT_COPY,
  DEVICE_PASS_NOT_SANDBOX_COPY,
  DEVICE_PASS_RATE_COPY,
} from '../../../shared/copy/workbench-device-pass.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { sandboxOfUser } from '../developer/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { deviceTestIdentity } from './device-pass-identity.ts';
import { pushDevicePass } from './device-pass-push.ts';
import {
  countCreatedSince,
  countOpen,
  type DevicePassRow,
  endDevicePass,
  getDevicePass,
  insertDevicePass,
  listDevicePasses,
  replaceCode,
} from './repo-device-pass.ts';
import { isBlocked } from './repo-device-pass-devices.ts';

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

const notSandbox = () => new ConflictError(DEVICE_PASS_NOT_SANDBOX_COPY, 'DEVICE_PASS_NOT_SANDBOX');
const notFound = () => new NotFoundError('Device pass not found.', 'DEVICE_PASS_NOT_FOUND');

export function toDto(row: DevicePassRow, code: DevicePassDto['code'] = null): DevicePassDto {
  return {
    id: row.id,
    passId: row.pass_id,
    state: row.state,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deviceCount: row.device_count,
    lastSeenAt: row.last_seen_at,
    code,
  };
}

const audit = (
  ctx: ServiceContext,
  row: { id: string; org_id: string },
  actor: { type: 'user' | 'system'; id: string | null },
  action: string,
  detail: Record<string, unknown> = {},
) =>
  recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: `device_pass.${action}`,
    targetType: 'device_pass',
    targetId: row.id,
    detail,
  });

/** The caller's own open sandbox: device passes are for a developer's own Test passes and nothing else. */
async function ownSandbox(ctx: ServiceContext, auth: SessionAuth): Promise<string> {
  const sandbox = await sandboxOfUser(ctx.env.DB, auth.userId);
  if (!sandbox || sandbox.closed_at !== null) throw notSandbox();
  return sandbox.org_id;
}

/** A device pass of the caller's own sandbox, or a 404: another developer's is not told apart from a missing one. */
async function ownedRow(
  ctx: ServiceContext,
  auth: SessionAuth,
  id: string,
): Promise<DevicePassRow> {
  const orgId = await ownSandbox(ctx, auth);
  const row = await getDevicePass(ctx.env.DB, id);
  if (!row || row.org_id !== orgId || row.user_id !== auth.userId) throw notFound();
  return row;
}

const codeUrl = (ctx: ServiceContext, code: string) => `${baseUrl(ctx.env)}/d/${code}`;

async function newCode(
  ctx: ServiceContext,
): Promise<{ code: string; hash: string; expiresAt: number }> {
  const code = ctx.ids.token(32);
  return {
    code,
    hash: await sha256Hex(code),
    expiresAt: ctx.clock.now() + DEVICE_PASS_CODE_TTL_MS,
  };
}

/**
 * Makes a device pass of one of the caller's own Test passes and its first code. The checks run in the order a
 * developer can act on them; the cap is counted in the statement that inserts, so two calls cannot both take the
 * last place. The route owns the flag, step-up and the idempotency key.
 */
export async function createDevicePass(
  ctx: ServiceContext,
  auth: SessionAuth,
  passId: string,
  againOf: string | null = null,
): Promise<DevicePassDto> {
  const orgId = await ownSandbox(ctx, auth);
  const pass = await getPass(ctx.env.DB, passId);
  if (!pass || pass.orgId !== orgId || pass.mode !== 'test') throw notSandbox();
  if (
    pass.status !== 'active' ||
    pass.removedAt !== null ||
    pass.deletedAt !== null ||
    pass.testDataQuarantined
  )
    throw new ConflictError('The pass is voided or removed.', 'DEVICE_PASS_SOURCE_VOIDED');
  if (await isBlocked(ctx.env.DB, auth.userId))
    throw new ForbiddenError(DEVICE_PASS_BLOCKED_COPY, 'DEVICE_PASS_BLOCKED');
  const now = ctx.clock.now();
  if ((await countCreatedSince(ctx.env.DB, auth.userId, now - HOUR)) >= DEVICE_PASS_PER_HOUR)
    throw new AppError('DEVICE_PASS_RATE_LIMITED', 429, DEVICE_PASS_RATE_COPY, {
      headers: { 'retry-after': '3600' },
    });
  await deviceTestIdentity(ctx);
  const code = await newCode(ctx);
  const id = ctx.ids.id();
  const made = await insertDevicePass(ctx.env.DB, {
    id,
    orgId,
    passId,
    userId: auth.userId,
    authNonce: ctx.ids.token(16),
    codeHash: code.hash,
    codeExpiresAt: code.expiresAt,
    againOf,
    sourceVersion: pass.version,
    now,
    expiresAt: now + DEVICE_PASS_TTL_MS,
    cap: DEVICE_PASS_MAX_ACTIVE,
  });
  if (!made) throw new ConflictError(DEVICE_PASS_LIMIT_COPY, 'DEVICE_PASS_LIMIT');
  const row = await getDevicePass(ctx.env.DB, id);
  if (!row) throw notFound();
  const actor = { type: 'user', id: auth.userId } as const;
  await audit(ctx, row, actor, 'created', { passId, ...(againOf ? { againOf } : {}) });
  await audit(ctx, row, actor, 'code_issued', { codes: 1 });
  return toDto(row, { url: codeUrl(ctx, code.code), expiresAt: code.expiresAt });
}

/** A new code for a pending pass. The old code stops working; a pass holds 5 codes at most. */
export async function issueCode(
  ctx: ServiceContext,
  auth: SessionAuth,
  id: string,
): Promise<DevicePassDto> {
  const row = await ownedRow(ctx, auth, id);
  const code = await newCode(ctx);
  const done = await replaceCode(ctx.env.DB, {
    id,
    orgId: row.org_id,
    hash: code.hash,
    codeExpiresAt: code.expiresAt,
    now: ctx.clock.now(),
  });
  if (!done) {
    const current = (await getDevicePass(ctx.env.DB, id)) ?? row;
    if (current.state === 'pending' && current.codes_issued >= 5)
      throw new ConflictError(DEVICE_PASS_CODE_LIMIT_COPY, 'DEVICE_PASS_CODE_LIMIT');
    throw new ConflictError(DEVICE_PASS_CODE_USED_COPY, 'DEVICE_PASS_CODE_USED');
  }
  const fresh = (await getDevicePass(ctx.env.DB, id)) ?? row;
  await audit(ctx, fresh, { type: 'user', id: auth.userId }, 'code_issued', {
    codes: fresh.codes_issued,
  });
  return toDto(fresh, { url: codeUrl(ctx, code.code), expiresAt: code.expiresAt });
}

/** Add again: a new device pass of the same source, after the old one ended. It counts against the 5. */
export async function addAgain(
  ctx: ServiceContext,
  auth: SessionAuth,
  id: string,
): Promise<DevicePassDto> {
  const row = await ownedRow(ctx, auth, id);
  if ((row.state === 'pending' || row.state === 'active') && row.expires_at <= ctx.clock.now()) {
    // Past its expiry the pass is ended here, not left for the sweep.
    if (await endDevicePass(ctx.env.DB, id, 'expired', ctx.clock.now())) {
      await audit(ctx, row, { type: 'system', id: null }, 'expired');
      ctx.waitUntil(pushDevicePass(ctx, id));
    }
  } else if (row.state === 'pending' || row.state === 'active')
    throw new ConflictError('This device pass is still open.', 'DEVICE_PASS_STILL_OPEN');
  return createDevicePass(ctx, auth, row.pass_id, row.id);
}

/** Active passes and the last 7 days. */
export async function listOwn(ctx: ServiceContext, auth: SessionAuth) {
  const orgId = await ownSandbox(ctx, auth);
  const now = ctx.clock.now();
  const [rows, active] = await Promise.all([
    listDevicePasses(ctx.env.DB, orgId, now - WEEK, now),
    countOpen(ctx.env.DB, orgId, now),
  ]);
  return { items: rows.map((row) => toDto(row)), active, limit: DEVICE_PASS_MAX_ACTIVE };
}

/** Ends the pass and pushes the voided copy to its phones. Ending an ended pass changes nothing. */
export async function voidOwn(
  ctx: ServiceContext,
  auth: SessionAuth,
  id: string,
): Promise<DevicePassDto> {
  const row = await ownedRow(ctx, auth, id);
  const ended = await endDevicePass(ctx.env.DB, id, 'developer', ctx.clock.now());
  if (ended) {
    await audit(ctx, row, { type: 'user', id: auth.userId }, 'voided', { reason: 'developer' });
    ctx.waitUntil(pushDevicePass(ctx, id));
  }
  return toDto((await getDevicePass(ctx.env.DB, id)) ?? row);
}
