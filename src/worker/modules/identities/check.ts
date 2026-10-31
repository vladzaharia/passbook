import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { resolveRow } from './db-resolver.ts';
import {
  ensurePlatformIdentity,
  getIdentityRow,
  type IdentityRow,
  listIdentityRows,
} from './repo.ts';
import { daysRemaining } from './service.ts';

export const EXPIRY_WARNING_DAYS = 30;

export interface IdentityCheckResult {
  at: number;
  ok: boolean;
  /** Stable error code when ok is false. */
  code?: string;
  daysRemaining: number | null;
}

const key = (id: string) => `identity_check.${id}`;

export async function lastIdentityCheck(
  db: D1Database,
  id: string,
): Promise<IdentityCheckResult | null> {
  return (await readSystemValue(db, key(id))) as IdentityCheckResult | null;
}

/** Proves the signing material still loads (decrypt for DB identities) and records the result. */
export async function checkIdentityRow(
  ctx: ServiceContext,
  row: IdentityRow,
): Promise<IdentityCheckResult> {
  const now = ctx.clock.now();
  const result: IdentityCheckResult = {
    at: now,
    ok: true,
    daysRemaining: daysRemaining(row.not_after, now),
  };
  try {
    await resolveRow(ctx.env, row);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    result.ok = false;
    result.code = error.code;
  }
  await writeSystemValue(ctx.env.DB, key(row.id), result, now);
  return result;
}

export async function checkIdentityById(
  ctx: ServiceContext,
  id: string,
): Promise<IdentityCheckResult | null> {
  const row = await getIdentityRow(ctx.env.DB, id);
  return row ? checkIdentityRow(ctx, row) : null;
}

/** Daily: sync the platform row, check every identity, audit expiry inside the warning window. */
export async function runDailyIdentityChecks(ctx: ServiceContext): Promise<void> {
  try {
    await ensurePlatformIdentity(ctx.env, ctx.clock.now());
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.info('identity.platform_not_configured', { code: error.code });
  }
  for (const row of await listIdentityRows(ctx.env.DB)) {
    const result = await checkIdentityRow(ctx, row);
    if (!result.ok)
      ctx.log.warn('identity.check_failed', { identityId: row.id, code: result.code });
    const days = result.daysRemaining;
    if (days === null || days > EXPIRY_WARNING_DAYS) continue;
    ctx.log.warn('identity.expiring', { identityId: row.id, days });
    await recordAudit(ctx, {
      actorType: 'system',
      orgId: row.org_id,
      action: days < 0 ? 'identity.expired' : 'identity.expiring',
      targetType: 'identity',
      targetId: row.id,
      detail: { daysRemaining: days, passTypeIdentifier: row.pass_type_identifier },
    });
  }
}
