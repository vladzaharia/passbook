import type { AuthContext } from '../../platform/auth.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/**
 * An upload or version save (a dry run too) builds and analyzes a package: each caller and each org
 * has a budget, so one tenant cannot hold the shared isolate with repeats.
 */
export async function enforceTemplateBudget(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string | null,
): Promise<void> {
  const who =
    auth?.kind === 'session'
      ? `user:${auth.userId}`
      : auth?.kind === 'api_key'
        ? `key:${auth.keyId}`
        : null;
  if (who) await enforceRateLimit(ctx.env, 'RL_TEMPLATE_UPLOAD', who);
  await enforceRateLimit(ctx.env, 'RL_TEMPLATE_UPLOAD', `org:${orgId ?? 'platform'}`);
}
