import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { endCliToken } from '../api-keys/repo-cli.ts';
import { recordAudit } from '../audit/service.ts';
import * as repo from './repo-cli.ts';

/**
 * `DELETE /cli/tokens/{id}` (`passbook logout`): a token ends itself, and a person ends a token of their own.
 * Any other id is not found.
 */
export async function logoutCliToken(
  ctx: ServiceContext,
  auth: ApiKeyAuth | SessionAuth,
  id: string,
): Promise<void> {
  const byDevice = auth.kind === 'api_key';
  if (
    byDevice
      ? auth.via !== 'cli' || auth.keyId !== id
      : !(await repo.ownsCliToken(ctx.env.DB, id, auth.userId))
  )
    throw new NotFoundError();
  if (await endCliToken(ctx.env.DB, id, 'logout', ctx.clock.now()))
    await recordAudit(ctx, {
      orgId: byDevice ? auth.orgId : null,
      actorType: byDevice ? 'api_key' : 'user',
      actorId: byDevice ? id : auth.userId,
      action: 'cli_token.revoked',
      targetType: 'api_key',
      targetId: id,
      detail: { reason: 'logout', by: byDevice ? 'device' : 'person' },
    });
}

/** The kill switch (`POST /platform/cli-tokens/revoke`): every CLI token, or those of one org or person. */
export async function revokeCliTokens(
  ctx: ServiceContext,
  admin: { userId: string },
  where: { orgId?: string | undefined; userId?: string | undefined },
): Promise<number> {
  const ended = await repo.endCliTokensWhere(
    ctx.env.DB,
    {
      ...(where.orgId !== undefined ? { orgId: where.orgId } : {}),
      ...(where.userId !== undefined ? { userId: where.userId } : {}),
    },
    'kill_switch',
    ctx.clock.now(),
  );
  const revoked = ended.length;
  await recordAudit(ctx, {
    orgId: where.orgId ?? null,
    actorType: 'user',
    actorId: admin.userId,
    action: 'cli_token.revoked',
    targetType: 'cli_token',
    targetId: where.userId ?? where.orgId ?? 'all',
    detail: { reason: 'kill_switch', by: 'platform', count: revoked },
  });
  return revoked;
}

/** A token ended by the system: one `cli_token.revoked` row each, `by: 'system'`. */
export async function auditSystemEnds(
  ctx: ServiceContext,
  ended: { token_id: string; org_id: string | null }[],
  reason: string,
): Promise<void> {
  for (const e of ended)
    await recordAudit(ctx, {
      orgId: e.org_id,
      actorType: 'system',
      action: 'cli_token.revoked',
      targetType: 'api_key',
      targetId: e.token_id,
      detail: { reason, by: 'system' },
    });
}

/** A person signed out everywhere, or their sandbox was reset: their CLI tokens end with it. */
export async function endCliTokensOf(
  ctx: ServiceContext,
  where: { userId: string } | { orgId: string },
  reason: 'sign_out_everywhere' | 'sandbox_reset',
) {
  const ended = await repo.endCliTokensWhere(ctx.env.DB, where, reason, ctx.clock.now());
  await auditSystemEnds(ctx, ended, reason);
  return ended.length;
}

/** Ends approved keys nobody collected (cron). */
export async function endUnclaimedCliTokens(ctx: ServiceContext): Promise<number> {
  const ended = await repo.endUnclaimedCliTokens(ctx.env.DB, ctx.clock.now());
  await auditSystemEnds(ctx, ended, 'unclaimed');
  return ended.length;
}
