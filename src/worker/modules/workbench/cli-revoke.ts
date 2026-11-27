import type { ApiKeyAuth } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { endCliToken } from '../api-keys/repo-cli.ts';
import { recordAudit } from '../audit/service.ts';
import * as repo from './repo-cli.ts';

/** `DELETE /cli/tokens/{id}`: a token ends itself (`passbook logout`). Any other id is not found. */
export async function logoutCliToken(
  ctx: ServiceContext,
  auth: ApiKeyAuth,
  id: string,
): Promise<void> {
  if (auth.via !== 'cli' || auth.keyId !== id) throw new NotFoundError();
  if (await endCliToken(ctx.env.DB, id, 'logout', ctx.clock.now()))
    await recordAudit(ctx, {
      orgId: auth.orgId,
      actorType: 'api_key',
      actorId: id,
      action: 'cli_token.revoked',
      targetType: 'api_key',
      targetId: id,
      detail: { reason: 'logout', by: 'device' },
    });
}

/** The kill switch (`POST /platform/cli-tokens/revoke`): every CLI token, or those of one org or person. */
export async function revokeCliTokens(
  ctx: ServiceContext,
  admin: { userId: string },
  where: { orgId?: string | undefined; userId?: string | undefined },
): Promise<number> {
  const revoked = await repo.endCliTokensWhere(
    ctx.env.DB,
    {
      ...(where.orgId !== undefined ? { orgId: where.orgId } : {}),
      ...(where.userId !== undefined ? { userId: where.userId } : {}),
    },
    'kill_switch',
    ctx.clock.now(),
  );
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

/** A person signed out everywhere, or their sandbox was reset: their CLI tokens end with it. */
export const endCliTokensOf = (
  ctx: ServiceContext,
  where: { userId: string } | { orgId: string },
  reason: 'sign_out_everywhere' | 'sandbox_reset',
) => repo.endCliTokensWhere(ctx.env.DB, where, reason, ctx.clock.now());
