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
import { tenantAuthorityOf } from '../passes/http.ts';
import {
  adminActor,
  captureScanTenantAuthority,
  denyInvalidScannerScope,
  type ScanActor,
  scannerActor,
  scanScannerCsrfProof,
  tenantScanRole,
  withRole,
} from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { resolvedRowOf } from './auth-store.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { getScanner, type ScannerRow, unbindStaff } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import type { ScanStaffRow } from './repo-staff.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import {
  captureObservedScanningSession,
  restoreObservedScanningSession,
} from './scanning-workspace-observation.ts';
import { rawScopeOf, resolveAdminScope } from './scope.ts';
import { bindingExpired, boundStaff } from './staff-binding.ts';

export type { ScanActor } from './actor.ts';

/** A spread drops the non-enumerable epochs of a `ScannerRow`; later writes on the copy need them. */
function withRowEpochs<T extends object>(copy: T, from: ScannerRow): T {
  if (from.credentialEpoch !== undefined && from.configEpoch !== undefined)
    Object.defineProperties(copy, {
      credentialEpoch: { value: from.credentialEpoch, enumerable: false },
      configEpoch: { value: from.configEpoch, enumerable: false },
    });
  return copy;
}

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

/** Terminal bearer, else the device cookie, else a user session. */
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
  const adminChosen = c.req.header('x-passbook-scan-admin') === '1' || !!c.req.query('setupId');
  if (device && !adminChosen) return { scanner: device };
  const sid = getCookie(c, SESSION_COOKIE);
  const session = sid ? await sessions.resolve(sid) : null;
  if (!session) throw unauthenticated();
  return { admin: session };
}

export interface GuardOptions {
  /** `GET /scan/session`, `POST|DELETE /scan/staff` and `POST /scan/unpair` run before anyone signs in. */
  staffOptional?: boolean;
  /** `GET /scan/session` and `POST /scan/unpair`: a customer or monitor screen may call them. */
  screens?: boolean;
  /** Tenant capability required of user sessions; configuration management is the safe default. */
  capability?: 'scanning:read' | 'scanning:manage' | 'passes:operate';
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
    const context = serviceContext(c);
    const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
    const original = await credentialOf(c);
    const storeRow = 'scanner' in original ? resolvedRowOf(original.scanner) : undefined;
    const resolvedRow = storeRow ? { ...storeRow, csrfSecret: null } : undefined;
    const credential: Credential =
      'scanner' in original
        ? { scanner: { ...original.scanner } }
        : { admin: { ...original.admin, roles: [...original.admin.roles] } };
    let pendingStaff: ScanStaffRow | null = null;
    let scannerEpochs: { credential: number; config: number } | undefined;
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
      const row = resolvedRow ?? (await getScanner(ctx.env.DB, auth.scannerId));
      if (
        !row ||
        row.id !== auth.scannerId ||
        row.orgId !== auth.orgId ||
        row.mode !== auth.mode ||
        row.kind !== auth.scannerKind ||
        row.deviceRole !== auth.deviceRole ||
        (auth.transport === 'bearer') !== (row.kind === 'terminal')
      )
        throw unauthenticated();
      const epochRow = storeRow ?? row;
      if (epochRow.credentialEpoch !== undefined && epochRow.configEpoch !== undefined)
        scannerEpochs = { credential: epochRow.credentialEpoch, config: epochRow.configEpoch };
      const terminal = auth.transport === 'bearer';
      const csrfSecret = terminal ? null : auth.csrfSecret;
      if (!terminal && !csrfSecret) throw unauthenticated();
      const scanner = withRowEpochs({ ...row, csrfSecret: null }, epochRow);
      const staffId =
        !terminal && scanner.staffId && !bindingExpired(scanner, ctx.clock.now())
          ? scanner.staffId
          : null;
      const scope = await readScannerScope(ctx.env.DB, scanner, staffId);
      const actor = scannerActor(ctx, scanner, auth.mode, auth.transport, scope);
      actor.scannerCsrfProof = csrfSecret
        ? await scanScannerCsrfProof(ctx.env, scanner.id, csrfSecret)
        : null;
      pendingStaff = scope.staff;
      c.set('auth', auth);
      withRole(actor, null);
      c.set('scanActor', actor);
    } else {
      const session = credential.admin;
      await csrfGuard(c, session);
      const setupId =
        rawScope && typeof rawScope === 'object' && 'setupId' in rawScope
          ? (rawScope as { setupId?: string }).setupId
          : undefined;
      const managedRow = setupId ? await getScanner(ctx.env.DB, setupId) : null;
      if (managedRow?.credentialEpoch !== undefined && managedRow.configEpoch !== undefined)
        scannerEpochs = { credential: managedRow.credentialEpoch, config: managedRow.configEpoch };
      const mode = managedRow?.mode ?? modeFromRequest(c);
      const scope = await resolveAdminScope(c, rawScope, mode);
      const sessionAuth = { ...session, mode };
      const authority = await tenantAuthorityOf(
        ctx,
        sessionAuth,
        scope.orgId,
        options.capability ?? 'scanning:manage',
      );
      if (authority.kind !== 'session') throw new ForbiddenError();
      const role = tenantScanRole(authority);
      if (!role) throw new ForbiddenError();
      const actor = setupId
        ? await managedAdminActor(ctx, session, mode, scope.orgId, setupId)
        : adminActor(session, mode, scope);
      if (!setupId && scope.event && scope.templateIds.length === 0) {
        actor.adminEventTemplates = true;
        actor.templateIds = scope.eventTemplateIds;
      }
      c.set('auth', sessionAuth);
      actor.platformSessionId = session.sessionId;
      actor.role = role;
      actor.tenantAuthority = await captureScanTenantAuthority(ctx, session, authority);
      await admit(c, actor.orgId, actor.actorKey);
      if (actor.scanner && actor.scanner.deviceRole !== 'scan' && !options.screens)
        throw new ForbiddenError('This device is a screen.', 'SCREEN_ONLY');
      c.set('scanActor', actor);
    }
    const actor = scanActorOf(c);
    await bindScanningSession(ctx, actor);
    denyInvalidScannerScope(actor);
    if (actor.principal === 'scanner') {
      const scanner = actor.scanner;
      if (scanner) {
        const boundBefore = scanner.staffId;
        const previousWorkspace = captureObservedScanningSession(actor);
        if (!actor.terminal) withRole(actor, await boundStaff(ctx, scanner, pendingStaff));
        if (!actor.settings.staffSignIn && scanner.staffId) await unbindStaff(ctx.env.DB, scanner);
        if (scanner.staffId !== boundBefore) {
          actor.staff = null;
          // Clearing a binding is a volatile write: it moves no epoch, so the workspace stays
          // as observed. Only the device row stamp the observation carries is refreshed.
          if (
            actor.scanningSession &&
            (!previousWorkspace ||
              !restoreObservedScanningSession(actor, {
                ...previousWorkspace,
                device: { ...previousWorkspace.device, updated_at: scanner.updatedAt },
              }))
          )
            throw unauthenticated();
        }
      }
      withRole(actor, actor.settings.staffSignIn ? actor.staff : null);
    }
    await captureScanEpochs(ctx.env.DB, actor, scannerEpochs, pendingStaff?.pinHash);
    if (actor.role === null && !options.staffOptional)
      throw new ForbiddenError('Sign in to scan.', 'STAFF_REQUIRED');
    if (
      actor.scanningSession &&
      actor.scanningSession.status !== 'active' &&
      c.req.method === 'POST' &&
      !c.req.path.endsWith('/device') &&
      !c.req.path.endsWith('/unpair')
    )
      throw new ForbiddenError(
        'This scanning session is paused. Resume it in Scanning.',
        'SCANNING_SESSION_PAUSED',
      );
    await next();
  });
}
