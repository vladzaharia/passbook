import type { ServiceContext } from '../../platform/service-context.ts';
import { patchConnection } from './repo.ts';
import { listExpiredPreviousSecrets } from './repo-credentials.ts';
import { dropCredentials } from './secrets.ts';

const PER_PASS = 100;

/**
 * Forgets previous webhook secrets whose overlap has ended. Verification already ignores them; this
 * deletes the stored copy. Returns how many connections were cleared.
 */
export async function dropExpiredPreviousSecrets(
  ctx: ServiceContext,
  now: number,
): Promise<number> {
  let cleared = 0;
  for (const c of await listExpiredPreviousSecrets(ctx.env.DB, now, PER_PASS)) {
    const patched = await patchConnection(
      ctx,
      c.id,
      { webhookPrevCredentialId: null, webhookPrevUntil: null, updatedAt: now },
      { actor: { orgId: c.orgId } },
    );
    if (patched === 0) continue;
    await dropCredentials(ctx, [c.credentialId]);
    cleared += 1;
  }
  return cleared;
}
