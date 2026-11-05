import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import {
  modeFromRequest,
  SCANNER_COOKIE,
  SCANNER_TOKEN,
  type ScannerAuth,
  SESSION_COOKIE,
  type SessionAuth,
} from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { csrfGuard } from '../../platform/csrf.ts';
import { reportDenied } from '../../platform/denied.ts';
import { ForbiddenError, UnauthenticatedError, ValidationError } from '../../platform/errors.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { adminActor, type ScanActor, scannerActor, withRole } from './actor.ts';
import { resolvedRowOf } from './auth-store.ts';
import { getScanner } from './repo-device.ts';
import { eventTemplateIds, readScannerScope } from './repo-scope.ts';
import { rawScopeOf, resolveAdminScope } from './scope.ts';
import { bindingExpired, boundStaff } from './staff-binding.ts';

export type { ScanActor } from './actor.ts';

declare module 'hono' {
  interface ContextVariableMap {
    scanActor: ScanActor;
  }
}

export function scanActorOf(c: Context<AppBindings>): ScanActor {
  const actor = c.get('scanActor');
  if (!actor) throw unauthenticated();
  return actor;
}

const unauthenticated = () =>
  new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');

type Credential = { scanner: ScannerAuth } | { admin: SessionAuth };

/** Terminal bearer, else the device cookie, else an admin session. A user session is refused. */
async function credentialOf(c: Context<AppBindings>): Promise<Credential> {
  const { scanners, sessions } = c.var.stores;
  const meta = { ipPrefix: ipPrefix(c.req.header('cf-connecting-ip')) };
  const header = c.req.header('authorization');
  if (header) {
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const auth =
      token && SCANNER_TOKEN.test(token) ? await scanners.resolve(token, 'bearer', meta) : null;
    if (!auth) throw unauthenticated();
    return { scanner: auth };
  }
  const cookie = getCookie(c, SCANNER_COOKIE);
  const device = cookie ? await scanners.resolve(cookie, 'cookie', meta) : null;
  if (device) return { scanner: device };
  const sid = getCookie(c, SESSION_COOKIE);
  const session = sid ? await sessions.resolve(sid) : null;
  if (!session) throw unauthenticated();
  if (!session.roles.includes('admin')) {
    reportDenied(c, 'FORBIDDEN', session);
    throw new ForbiddenError('Admin access is required.');
  }
  return { admin: session };
}

export interface GuardOptions {
  /** `GET /scan/session`, `POST|DELETE /scan/staff` and `POST /scan/unpair` run before anyone signs in. */
  staffOptional?: boolean;
  /** `GET /scan/session` and `POST /scan/unpair`: a customer or monitor screen may call them. */
  screens?: boolean;
}

/** Org active, then the two rate limits (SA 2.5 steps 2 and 3). */
async function admit(c: Context<AppBindings>, orgId: string, actorKey: string): Promise<void> {
  if (!(await isOrgActive(serviceContext(c), orgId)))
    throw new ForbiddenError('This organization is suspended.', 'ORG_INACTIVE');
  await enforceRateLimit(c.env, 'RL_SCAN_ORG', `org:${orgId}`);
  await enforceRateLimit(c.env, 'RL_SCAN', actorKey);
}

/**
 * Every scan route's guard, in SA 2.5 order: credential, org active, rate limits, device role,
 * staff binding. Leaves a normalized `ScanActor` on the context. A scanner's rows are read once
 * the checks that need no rows have passed: the scanner row comes from the store's own read, and
 * the event, templates and staff share one batch.
 */
export function requireScanActor(options: GuardOptions = {}): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    const credential = await credentialOf(c);
    const ctx = serviceContext(c);
    const rawScope = await rawScopeOf(c);
    if ('scanner' in credential) {
      const auth = credential.scanner;
      await csrfGuard(c, auth);
      if (rawScope !== undefined)
        throw new ValidationError(
          'A scanner cannot choose what it scans.',
          [],
          'SCAN_SCOPE_NOT_ALLOWED',
        );
      await admit(c, auth.orgId, `s:${auth.scannerId}`);
      if (auth.deviceRole !== 'scan' && !options.screens) {
        reportDenied(c, 'FORBIDDEN', auth);
        throw new ForbiddenError('This device is a screen.', 'SCREEN_ONLY');
      }
      const row = resolvedRowOf(auth) ?? (await getScanner(c.env.DB, auth.scannerId));
      if (!row || row.orgId !== auth.orgId) throw unauthenticated();
      const terminal = auth.transport === 'bearer';
      const staffId =
        !terminal && row.staffId && !bindingExpired(row, ctx.clock.now()) ? row.staffId : null;
      const scope = await readScannerScope(c.env.DB, row, staffId);
      const actor = scannerActor(ctx, row, auth.mode, auth.transport, scope);
      c.set('auth', auth);
      if (terminal) withRole(actor, null);
      else {
        withRole(actor, await boundStaff(ctx, row, scope.staff));
        if (actor.role === null && !options.staffOptional)
          throw new ForbiddenError('Sign in to scan.', 'STAFF_REQUIRED');
      }
      c.set('scanActor', actor);
    } else {
      const session = credential.admin;
      await csrfGuard(c, session);
      const mode = modeFromRequest(c);
      const scope = await resolveAdminScope(c, rawScope, mode);
      const actor = adminActor(session, mode, scope);
      if (scope.event && scope.templateIds.length === 0)
        actor.templateIds = await eventTemplateIds(c.env.DB, scope.orgId, scope.event.id);
      c.set('auth', { ...session, mode });
      await admit(c, actor.orgId, actor.actorKey);
      c.set('scanActor', actor);
    }
    await next();
  });
}
