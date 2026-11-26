import type { WorkbenchToken } from '../../../shared/contracts/workbench.ts';
import { SANDBOX_KEY_MISSING_COPY } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tryKeyOf } from '../developer/repo-try.ts';
import { revokeTryTokens } from '../developer/try-token.ts';
import { bumpMemberEpoch, type MintTarget, mintTargetOf } from './repo.ts';
import { signWorkbenchToken, tokenBucket, WORKBENCH_TOKEN_TTL_MS } from './token.ts';

const notFound = () => new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');

/**
 * The org a token may be minted for: one the person belongs to, and a developer org only when it is their own
 * open sandbox. Anything else is not found. The route checks the console group against it.
 */
export async function mintTarget(
  ctx: ServiceContext,
  session: SessionAuth,
  orgId: string,
): Promise<MintTarget & { sandbox: boolean }> {
  await enforceRateLimit(ctx.env, 'RL_API_TRY', tokenBucket(session.sessionId));
  const target = await mintTargetOf(ctx.env.DB, session.userId, orgId, session.sessionId);
  if (!target) throw notFound();
  const sandbox = target.org_kind === 'developer';
  if (sandbox && target.own_sandbox !== orgId) throw notFound();
  return { ...target, sandbox };
}

/** A 15-minute token bound to this session and the org: the sandbox key in a sandbox, else the membership. */
export async function issueWorkbenchToken(
  ctx: ServiceContext,
  session: SessionAuth,
  target: MintTarget & { sandbox: boolean },
): Promise<WorkbenchToken> {
  const now = ctx.clock.now();
  const expiresAt = now + WORKBENCH_TOKEN_TTL_MS;
  const base = { orgId: target.org_id, sessionIdHash: session.sessionId, expiresAt };
  if (target.sandbox) {
    const found = await tryKeyOf(ctx.env.DB, session.userId, now);
    if (!found) throw notFound();
    if (!found.key_id) throw new ConflictError(SANDBOX_KEY_MISSING_COPY, 'SANDBOX_KEY_MISSING');
    const token = await signWorkbenchToken(ctx.env, {
      ...base,
      subject: 'sandbox_key',
      ref: found.key_id,
      generation: found.try_generation,
    });
    ctx.log.info('workbench.token_minted', { orgId: target.org_id, subject: 'sandbox_key' });
    return { token, orgId: target.org_id, mode: 'test', expiresAt, subject: 'sandbox_key' };
  }
  const token = await signWorkbenchToken(ctx.env, {
    ...base,
    subject: 'member',
    ref: target.membership_id,
    generation: target.generation,
  });
  ctx.log.info('workbench.token_minted', { orgId: target.org_id, subject: 'member' });
  return { token, orgId: target.org_id, mode: 'test', expiresAt, subject: 'member' };
}

/** Ends this session's tokens for the org: a sandbox's try generation, or the session's member epoch. */
export async function endWorkbenchTokens(
  ctx: ServiceContext,
  session: SessionAuth,
  target: MintTarget & { sandbox: boolean },
): Promise<void> {
  if (target.sandbox) return revokeTryTokens(ctx, session);
  await bumpMemberEpoch(ctx.env.DB, session.sessionId, ctx.clock.now());
  ctx.log.info('workbench.tokens_ended', { orgId: target.org_id });
}
