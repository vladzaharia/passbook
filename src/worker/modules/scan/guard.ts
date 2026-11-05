import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type ScannerSettings,
  ScannerSettingsSchema,
  type ScanRole,
} from '../../../shared/contracts/scan.ts';
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
import { getScanner, type ScannerRow } from './repo-device.ts';
import { eventTemplateIds, getEvent, type ScanEventRow, scannerTemplateIds } from './repo-scope.ts';
import { effectiveRole } from './rules.ts';
import { rawScopeOf, resolveAdminScope } from './scope.ts';
import { type BoundStaff, boundStaff } from './staff-binding.ts';

export interface ScanActor {
  principal: 'scanner' | 'admin';
  orgId: string;
  mode: Mode;
  /** `s:<scannerId>` or `u:<userId>`: the idempotency namespace and "own". */
  actorKey: string;
  actor: { type: 'scanner' | 'user'; id: string };
  scanner: ScannerRow | null;
  event: ScanEventRow | null;
  templateIds: string[];
  timeZone: string;
  /** Null only on routes exempt from staff sign-in, while it is required and missing. */
  role: ScanRole | null;
  staff: BoundStaff | null;
  settings: ScannerSettings;
  /** "Front door", or "Admin console". */
  name: string;
  /** A bearer terminal: its role, no staff, no approvals. */
  terminal: boolean;
}

/** An admin scans with everything on. */
export const ADMIN_SETTINGS: ScannerSettings = {
  flow: 'choose',
  defaultActionId: null,
  roleWithoutSignIn: 'desk',
  staffSignIn: false,
  letInAgain: 'anyone',
  reader: 'none',
  lookup: true,
  offline: false,
  dailyAmount: null,
};

/** Used when a stored settings blob does not parse: the strictest posture. */
const LOCKED_SETTINGS: ScannerSettings = {
  ...ADMIN_SETTINGS,
  flow: 'auto',
  roleWithoutSignIn: 'door',
  letInAgain: 'manager',
  lookup: false,
};

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

function settingsOf(c: Context<AppBindings>, row: ScannerRow): ScannerSettings {
  try {
    const parsed = ScannerSettingsSchema.safeParse(JSON.parse(row.settings));
    if (parsed.success) return parsed.data;
  } catch {
    // falls through to the log below
  }
  c.var.log.error('scan.settings_invalid', { code: 'SCAN_SETTINGS_INVALID', scannerId: row.id });
  return LOCKED_SETTINGS;
}

export interface GuardOptions {
  /** `GET /scan/session`, `POST|DELETE /scan/staff` and `POST /scan/unpair` run before anyone signs in. */
  staffOptional?: boolean;
}

/**
 * Every scan route's guard, in SA 2.5 order: credential, org active, rate limits, staff binding.
 * Leaves a normalized `ScanActor` on the context.
 */
export function requireScanActor(options: GuardOptions = {}): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    const credential = await credentialOf(c);
    const ctx = serviceContext(c);
    const rawScope = await rawScopeOf(c);
    let actor: ScanActor;
    if ('scanner' in credential) {
      const auth = credential.scanner;
      await csrfGuard(c, auth);
      if (rawScope !== undefined)
        throw new ValidationError(
          'A scanner cannot choose what it scans.',
          [],
          'SCAN_SCOPE_NOT_ALLOWED',
        );
      const row = await getScanner(c.env.DB, auth.scannerId);
      if (!row) throw unauthenticated();
      const eventRow = row.eventId ? await getEvent(c.env.DB, row.orgId, row.eventId) : null;
      const settings = settingsOf(c, row);
      const terminal = auth.transport === 'bearer';
      actor = {
        principal: 'scanner',
        orgId: row.orgId,
        mode: auth.mode,
        actorKey: `s:${row.id}`,
        actor: { type: 'scanner', id: row.id },
        scanner: row,
        event: eventRow,
        templateIds: eventRow
          ? await eventTemplateIds(c.env.DB, eventRow.id)
          : await scannerTemplateIds(c.env.DB, row.id),
        timeZone: eventRow?.timeZone ?? row.timeZone,
        role: null,
        staff: null,
        settings,
        name: row.name,
        terminal,
      };
      c.set('auth', auth);
    } else {
      const session = credential.admin;
      await csrfGuard(c, session);
      const mode = modeFromRequest(c);
      const scope = await resolveAdminScope(c, rawScope, mode);
      actor = {
        principal: 'admin',
        orgId: scope.orgId,
        mode,
        actorKey: `u:${session.userId}`,
        actor: { type: 'user', id: session.userId },
        scanner: null,
        event: scope.event,
        templateIds:
          scope.event && scope.templateIds.length === 0
            ? await eventTemplateIds(c.env.DB, scope.event.id)
            : scope.templateIds,
        timeZone: scope.timeZone,
        role: 'manager',
        staff: null,
        settings: ADMIN_SETTINGS,
        name: 'Admin console',
        terminal: false,
      };
      c.set('auth', { ...session, mode });
    }

    if (!(await isOrgActive(ctx, actor.orgId)))
      throw new ForbiddenError('This organization is suspended.', 'ORG_INACTIVE');
    await enforceRateLimit(c.env, 'RL_SCAN_ORG', `org:${actor.orgId}`);
    await enforceRateLimit(c.env, 'RL_SCAN', actor.actorKey);

    if (actor.scanner && !actor.terminal) {
      actor.staff = await boundStaff(ctx, actor.scanner);
      actor.role = effectiveRole({
        principal: 'scanner',
        staffRole: actor.staff?.role ?? null,
        settings: actor.settings,
      });
      if (actor.role === null && !options.staffOptional)
        throw new ForbiddenError('Sign in to scan.', 'STAFF_REQUIRED');
    } else if (actor.terminal) {
      actor.role = actor.settings.roleWithoutSignIn;
    }
    c.set('scanActor', actor);
    await next();
  });
}
