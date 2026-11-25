import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { createUser } from './account-claims.ts';
import * as repo from './repo.ts';
import { bumpCounter } from './repo-magic.ts';
import { type SignInContext, type SignInResult, startSession } from './service.ts';

export const BREAKGLASS_PROVIDER = 'breakglass';
const BREAKGLASS_EMAIL = 'breakglass@wallet.invalid';

/**
 * Admin sign-in that does not depend on Pocket ID. The token itself is checked by the handler;
 * this only resolves the dedicated user, refusing it when an admin has disabled it.
 */
export async function signInBreakglass(
  ctx: ServiceContext,
  sign: SignInContext,
): Promise<SignInResult> {
  const linked = await repo.findIdentity(ctx.env.DB, BREAKGLASS_PROVIDER, BREAKGLASS_PROVIDER);
  let userId = linked?.user_id;
  if (!userId) {
    const user =
      (await repo.findUserByPrimaryEmail(ctx.env.DB, BREAKGLASS_EMAIL)) ??
      (await createUser(ctx, BREAKGLASS_EMAIL, 'Break-glass admin'));
    await repo.insertIdentity(ctx.env.DB, {
      provider: BREAKGLASS_PROVIDER,
      subject: BREAKGLASS_PROVIDER,
      userId: user.id,
      emailClaim: null,
      emailVerified: false,
      groups: [],
      now: ctx.clock.now(),
    });
    userId = user.id;
  }
  const user = await repo.getUser(ctx.env.DB, userId);
  if (user?.status !== 'active') {
    throw new ForbiddenError('Break-glass sign-in is disabled.', 'BREAKGLASS_DISABLED');
  }
  const result = await startSession(ctx, user.id, ['admin', 'user'], 'breakglass', user.name, sign);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: user.id,
    action: 'auth.breakglass_used',
    targetType: 'user',
    targetId: user.id,
    ipPrefix: sign.ipPrefix,
  });
  return result;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FAILURE_ROWS_PER_HOUR = 100;

/** Audits a wrong token, capped per hour so guessing cannot flood the log; the day count is exact. */
export async function recordBreakglassFailure(
  ctx: ServiceContext,
  prefix: string | null,
): Promise<void> {
  const now = ctx.clock.now();
  await bumpCounter(ctx.env.DB, 'breakglass:fail', now - (now % DAY));
  const rows = await bumpCounter(ctx.env.DB, 'audit:breakglass_failed', now - (now % HOUR));
  if (rows > FAILURE_ROWS_PER_HOUR + 1) return;
  if (rows === FAILURE_ROWS_PER_HOUR + 1) {
    ctx.log.error('auth.breakglass_failed_capped', { code: 'BREAKGLASS_FAILURE_CAP' });
    return;
  }
  await recordAudit(ctx, {
    actorType: 'system',
    action: 'auth.breakglass_failed',
    ipPrefix: prefix,
    detail: { reason: 'wrong_token' },
  });
}
