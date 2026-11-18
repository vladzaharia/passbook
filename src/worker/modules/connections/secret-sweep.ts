import type { ServiceContext } from '../../platform/service-context.ts';
import { patchConnection } from './repo.ts';
import { listExpiredPreviousSecrets } from './repo-credentials.ts';
import { dropCredentials } from './secrets.ts';

const PER_PASS = 100;
/** Most connections cleared in one run; the rest wait for the next. */
const MAX_PER_RUN = 2000;

/**
 * Forgets previous webhook secrets whose overlap has ended. Verification already ignores them; this
 * deletes the stored copy. The patch only applies while the listed credential is still the previous
 * one, so a rotation in between keeps its new overlap. Returns how many connections were cleared.
 */
export async function dropExpiredPreviousSecrets(
  ctx: ServiceContext,
  now: number,
): Promise<number> {
  let cleared = 0;
  while (cleared < MAX_PER_RUN) {
    const batch = await listExpiredPreviousSecrets(ctx.env.DB, now, PER_PASS);
    let progress = 0;
    for (const c of batch) {
      const patched = await patchConnection(
        ctx,
        c.id,
        {
          webhookPrevCredentialId: null,
          webhookPrevUntil: null,
          webhookPrevSecretFp: null,
          updatedAt: now,
        },
        { actor: { orgId: c.orgId }, prevCredentialId: c.credentialId },
      );
      if (patched === 0) continue;
      await dropCredentials(ctx, [c.credentialId]);
      progress += 1;
    }
    cleared += progress;
    // A full pass that changed nothing (rows lost to races) must not spin.
    if (batch.length < PER_PASS || progress === 0) break;
  }
  return cleared;
}
