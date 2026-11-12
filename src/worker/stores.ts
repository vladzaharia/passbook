import { createApiKeyStore } from './modules/api-keys/service.ts';
import { recordAudit } from './modules/audit/service.ts';
import { bumpCounter } from './modules/auth/repo-magic.ts';
import { createSessionStore } from './modules/auth/sessions.ts';
import { createScannerStore } from './modules/scan/auth-store.ts';
import type { AuthStores } from './platform/auth.ts';
import type { AppEnv } from './platform/env.ts';
import { createDetachedContext } from './platform/service-context.ts';

const HOUR = 3_600_000;
const DENIED_ROWS_PER_HOUR = 500;

/** Production session (D1) and API-key stores, wired into createApp by index.ts. */
export function createAuthStores(env: AppEnv): AuthStores {
  return {
    sessions: createSessionStore(env),
    apiKeys: createApiKeyStore(env),
    scanners: createScannerStore(env),
    async onDenied(event) {
      const ctx = createDetachedContext(env);
      const now = ctx.clock.now();
      const n = await bumpCounter(env.DB, 'audit:auth_denied', now - (now % HOUR));
      if (n > DENIED_ROWS_PER_HOUR) {
        if (n === DENIED_ROWS_PER_HOUR + 1)
          ctx.log.error('auth.denied_capped', { code: 'AUTH_DENIED_CAP' });
        return;
      }
      await recordAudit(ctx, {
        actorType: event.actorType,
        actorId: event.actorId,
        action: 'auth.denied',
        ipPrefix: event.ipPrefix,
        detail: { code: event.code, route: event.route },
      });
    },
  };
}
