import type { Context } from 'hono';
import type { ApiKeyAuth, ScannerAuth, SessionAuth } from './auth.ts';
import type { AppBindings } from './context.ts';
import { ipPrefix } from './ip.ts';
import { serviceContext } from './service-context.ts';

export interface DeniedEvent {
  code: 'FORBIDDEN' | 'CSRF_ORIGIN' | 'CSRF_TOKEN' | 'MISSING_SCOPE';
  actorType: 'user' | 'api_key' | 'scanner';
  actorId: string;
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
    ipPrefix: ipPrefix(c.req.header('cf-connecting-ip')),
    route: c.req.matchedRoutes.findLast((r) => r.method !== 'ALL')?.path ?? c.req.routePath,
  };
  ctx.waitUntil(
    Promise.resolve(hook(event)).catch((error) =>
      ctx.log.warn('auth.denied_audit_failed', { code: 'DENIED_AUDIT', error }),
    ),
  );
}
