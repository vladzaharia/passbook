import type { Clock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createDetachedContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { bumpCounter } from '../auth/repo-magic.ts';

const HOUR = 3_600_000;
/** Rows an hour, apart from `auth.denied`'s cap: a flood from org keys must not hide a Platform key being probed. */
const REFUSED_ROWS_PER_HOUR = 200;

/**
 * An `api_key.refused` row naming a Platform key the gate or `keyAuthOf` refused after its secret matched (outside the
 * allowlist, expired, revoked, creator gone, over its write budget). The caller still sees the same 401 or 429, so the
 * row is no oracle; it is how the owner learns a leaked key is being tried. Capped, and never throws.
 */
export async function auditPlatformKeyRefusal(
  env: AppEnv,
  clock: Clock,
  refusal: {
    keyId: string;
    orgId: string | null;
    ipPrefix: string | null;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  const ctx = createDetachedContext(env, { clock });
  try {
    const now = ctx.clock.now();
    const n = await bumpCounter(env.DB, 'audit:platform_key_refused', now - (now % HOUR));
    if (n > REFUSED_ROWS_PER_HOUR) {
      if (n === REFUSED_ROWS_PER_HOUR + 1)
        ctx.log.error('api_key.refused_capped', { code: 'API_KEY_REFUSED_CAP' });
      return;
    }
    await recordAudit(ctx, {
      actorType: 'api_key',
      actorId: refusal.keyId,
      orgId: refusal.orgId,
      action: 'api_key.refused',
      ipPrefix: refusal.ipPrefix,
      detail: refusal.detail,
    });
  } catch (error) {
    ctx.log.warn('api_key.refused_audit_failed', { code: 'API_KEY_REFUSED_AUDIT', error });
  }
}
