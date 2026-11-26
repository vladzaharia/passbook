import type { Context } from 'hono';
import { apiKeyPrefixOf } from './api-key-token.ts';
import type { ApiKeyAuth, ScannerAuth, SessionAuth } from './auth.ts';
import type { AppBindings } from './context.ts';
import { ipPrefix } from './ip.ts';
import { serviceContext } from './service-context.ts';

export interface DeniedEvent {
  code:
    | 'FORBIDDEN'
    | 'CSRF_ORIGIN'
    | 'CSRF_TOKEN'
    | 'MISSING_SCOPE'
    | 'IDP_SIGN_IN_REQUIRED'
    | 'PLATFORM_KEY_REQUIRED'
    | 'PERSON_REQUIRED'
    | 'KEY_CANNOT_ADMINISTER'
    | 'RATE_LIMITED';
  actorType: 'user' | 'api_key' | 'scanner';
  actorId: string;
  /** The org of the refused key or scanner, when it has one. */
  orgId?: string | null;
  /** The refused principal is a Platform key: its refusals are audited apart (`api_key.refused`). */
  platformKey?: true;
  ipPrefix: string | null;
  /** Route template, never the concrete path. */
  route: string;
}

/**
 * Reports an authenticated principal being refused, for audit. Unknown keys and anonymous 401s
 * are not reported: anyone can trigger those.
 */
export function reportDenied(
  c: Context<AppBindings>,
  code: DeniedEvent['code'],
  auth: SessionAuth | ApiKeyAuth | ScannerAuth,
): void {
  const hook = c.var.stores.onDenied;
  if (!hook) return;
  const ctx = serviceContext(c);
  const event: DeniedEvent = {
    code,
    actorType: auth.kind === 'session' ? 'user' : auth.kind === 'scanner' ? 'scanner' : 'api_key',
    actorId:
      auth.kind === 'session' ? auth.userId : auth.kind === 'scanner' ? auth.scannerId : auth.keyId,
    ...(auth.kind === 'session' ? {} : { orgId: auth.orgId }),
    ...(auth.kind === 'api_key' && auth.keyKind === 'platform'
      ? { platformKey: true as const }
      : {}),
    ipPrefix: ipPrefix(c.req.header('cf-connecting-ip')),
    route: c.req.matchedRoutes.findLast((r) => r.method !== 'ALL')?.path ?? c.req.routePath,
  };
  ctx.waitUntil(
    Promise.resolve(hook(event)).catch((error) =>
      ctx.log.warn('auth.denied_audit_failed', { code: 'DENIED_AUDIT', error }),
    ),
  );
}

/**
 * Notes a key refused at the route gate (401 INVALID_API_KEY, 403 MISSING_SCOPE) on the request, so the one
 * `request.done` line the 4xx already writes carries a stable code (a second line would double the log volume
 * of an unauthenticated flood). An unknown key carries only the non-secret lookup prefix, never the token; it
 * is not audited (see `reportDenied`). A known key carries its id.
 */
export function noteKeyRefused(
  c: Context<AppBindings>,
  refusal:
    | { code: 'INVALID_API_KEY'; token: string }
    | {
        code: 'MISSING_SCOPE' | 'PLATFORM_KEY_REQUIRED' | 'PERSON_REQUIRED';
        keyId: string;
        scope: string | null;
      },
): void {
  c.set(
    'refusal',
    refusal.code === 'INVALID_API_KEY'
      ? { code: refusal.code, keyPrefix: apiKeyPrefixOf(refusal.token) }
      : { code: refusal.code, keyId: refusal.keyId, scope: refusal.scope },
  );
}
