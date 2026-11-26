import { auditPlatformKeyRefusal } from './modules/api-keys/refusal-audit.ts';
import { createApiKeyStore } from './modules/api-keys/service.ts';
import { recordAudit } from './modules/audit/service.ts';
import { bumpCounter } from './modules/auth/repo-magic.ts';
import { createSessionStore } from './modules/auth/sessions.ts';
import { createScannerStore } from './modules/scan/auth-store.ts';
import { createWorkbenchStore, withWorkbenchTokens } from './modules/workbench/resolve.ts';
import type { AuthStores } from './platform/auth.ts';
import { type Clock, systemClock } from './platform/clock.ts';
import type { AppEnv } from './platform/env.ts';
import { createDetachedContext } from './platform/service-context.ts';

const HOUR = 3_600_000;
const DENIED_ROWS_PER_HOUR = 500;

/** Production session (D1) and API-key stores, wired into createApp by index.ts. */
export function createAuthStores(env: AppEnv, clock?: Clock): AuthStores {
  return {
    sessions: createSessionStore(env, clock),
    // A `pbtry_` Workbench or try token resolves to its sandbox key while its session and sandbox hold.
    apiKeys: withWorkbenchTokens(env, createApiKeyStore(env, clock), clock),
    // On `auth` routes: the sandbox key, or a member's Test session on the allowlisted operations.
    workbench: createWorkbenchStore(env, clock),
    scanners: createScannerStore(env, clock),
    async onDenied(event) {
      // A Platform key's refusals have their own cap and row: `api_key.refused`, naming the key.
      if (event.platformKey)
        return auditPlatformKeyRefusal(env, clock ?? systemClock, {
          keyId: event.actorId,
          orgId: null,
          ipPrefix: event.ipPrefix,
          detail: { code: event.code, route: event.route },
        });
      const ctx = createDetachedContext(env, { clock });
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
        // The org of a refused key or scanner sees it in its own log too.
        orgId: event.orgId ?? null,
        ipPrefix: event.ipPrefix,
        detail: { code: event.code, route: event.route },
      });
    },
  };
}
