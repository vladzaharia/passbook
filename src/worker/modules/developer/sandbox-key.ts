import type { SandboxKey } from '../../../shared/contracts/developer.ts';
import { SANDBOX_KEY_NAME, SANDBOX_KEY_SHOWN_COPY } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sandboxOfUser } from './repo.ts';
import { reserveKey } from './repo-grants-reset.ts';
import { trackStartRaw } from './repo-reset.ts';
import { liveSandboxKeyOf } from './repo-sandbox-op.ts';
import { mintSandboxKey } from './service.ts';

/**
 * The sandbox's key, shown once. Making, resetting or starting over a sandbox ends without a secret; the page
 * calls this as that operation succeeds. While a live key exists it answers 409 `SANDBOX_KEY_SHOWN`: the secret
 * is not kept anywhere, so the person rolls it. The reservation is one batch, so two calls at once mint one key.
 */
export async function mintSandboxKeyOnce(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<SandboxKey> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (row.closed_at !== null)
    throw new ConflictError('The sandbox is closed. Reopen it first.', 'SANDBOX_CLOSED');
  if (await liveSandboxKeyOf(ctx.env.DB, row.org_id, session.userId, SANDBOX_KEY_NAME))
    throw new ConflictError(SANDBOX_KEY_SHOWN_COPY, 'SANDBOX_KEY_SHOWN');
  try {
    await reserveKey(
      ctx,
      { id: row.id, orgId: row.org_id },
      { userId: session.userId, sessionIdHash: session.sessionId },
      await trackStartRaw(ctx.env.DB, row.org_id),
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'SANDBOX_CONFLICT') throw error;
    throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
  }
  return mintSandboxKey(ctx, { ...session, mode: 'test' }, row.org_id);
}
