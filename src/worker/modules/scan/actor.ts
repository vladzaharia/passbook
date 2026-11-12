import type { Mode } from '../../../shared/contracts/common.ts';
import {
  type ScannerSettings,
  ScannerSettingsSchema,
  type ScanRole,
} from '../../../shared/contracts/scan.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqualBytes, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { scanTenantSession } from './repo-actor.ts';
import type { ScannerRow } from './repo-device.ts';
import type { ScanEventRow, ScannerAssignmentSnapshot } from './repo-scope.ts';
import { effectiveRole } from './rules.ts';
import type { ResolvedScope } from './scope.ts';
import type { BoundStaff } from './staff-binding.ts';

export type ScanTenantAuthority = Extract<TenantPassWrite, { kind: 'session' }> & {
  /** Keyed proof of the original platform session CSRF secret; never the secret itself. */
  sessionCreatedAt: number;
  sessionExpiresAt: number;
  sessionCsrfProof: string;
};

const proofEncoder = new TextEncoder();

function proofFrame(id: string, secret: string): Uint8Array {
  const idBytes = proofEncoder.encode(id);
  const secretBytes = proofEncoder.encode(secret);
  const frame = new Uint8Array(4 + idBytes.length + secretBytes.length);
  new DataView(frame.buffer).setUint32(0, idBytes.length);
  frame.set(idBytes, 4);
  frame.set(secretBytes, 4 + idBytes.length);
  return frame;
}

/** Capture the original session credential without carrying its raw CSRF secret. */
export async function scanSessionCsrfProof(
  env: object,
  sessionId: string,
  csrfSecret: string,
): Promise<string> {
  const snapshot = { ...env };
  const frame = proofFrame(sessionId, csrfSecret);
  const key = await derivedHmacKey(snapshot, 'scan-session-csrf.v1');
  const digest = await crypto.subtle.sign('HMAC', key, frame as BufferSource);
  return toBase64Url(new Uint8Array(digest));
}

/** Bind a scanner CSRF proof to its original scanner ID. */
export async function scanScannerCsrfProof(
  env: object,
  scannerId: string,
  csrfSecret: string,
): Promise<string> {
  const snapshot = { ...env };
  const frame = proofFrame(scannerId, csrfSecret);
  const key = await derivedHmacKey(snapshot, 'scan-scanner-csrf.v1');
  const digest = await crypto.subtle.sign('HMAC', key, frame as BufferSource);
  return toBase64Url(new Uint8Array(digest));
}

/** Bind the live D1 session to the original authenticated secret and immutable lifetime. */
export async function captureScanTenantAuthority(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: Extract<TenantPassWrite, { kind: 'session' }>,
): Promise<ScanTenantAuthority> {
  const env = { ...ctx.env };
  const sessionId = session.sessionId;
  const userId = session.userId;
  const csrfSecret = session.csrfSecret;
  const capturedAuthority = {
    ...authority,
    roles: [...authority.roles],
    sessionRoles: [...authority.sessionRoles],
  };
  if (sessionId !== capturedAuthority.sessionId || userId !== capturedAuthority.userId)
    throw new UnauthenticatedError();
  const row = await scanTenantSession(env.DB, sessionId, userId, ctx.clock.now(), ctx.clock.now());
  if (
    !row ||
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.expires_at) ||
    row.expires_at <= row.created_at ||
    typeof row.csrf_secret !== 'string' ||
    !row.csrf_secret ||
    !safeEqualBytes(proofEncoder.encode(row.csrf_secret), proofEncoder.encode(csrfSecret))
  )
    throw new UnauthenticatedError();
  return {
    ...capturedAuthority,
    sessionCreatedAt: row.created_at,
    sessionExpiresAt: row.expires_at,
    sessionCsrfProof: await scanSessionCsrfProof(env, sessionId, csrfSecret),
  };
}

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
  /** An admin requested the whole event rather than an explicit template subset. */
  adminEventTemplates?: boolean;
  /** The configured scanner scope is invalid or conflicts with its workspace. */
  invalidScannerScope?: boolean;
  /** Guard-captured raw assignment; used only to authorize minimal historical receipts. */
  scannerAssignment?: ScannerAssignmentSnapshot | null;
  timeZone: string;
  /** Null only on routes exempt from staff sign-in, while it is required and missing. */
  role: ScanRole | null;
  staff: BoundStaff | null;
  settings: ScannerSettings;
  /** "Front door", or "Admin console". */
  name: string;
  /** A bearer terminal: its role, no staff, no approvals. */
  terminal: boolean;
  scanningSession?: { id: string; status: 'active' | 'paused' | 'ended'; updatedAt: number };
  platformSessionId?: string;
  /** Keyed proof of the scanner credential's original CSRF secret. */
  scannerCsrfProof?: string | null;
  /** Original credential-reference keyset commitment, when credential evidence is observed. */
  credentialKeysetCommitment?: string;
  /** Exact tenant membership and session captured before a user-backed scan operation. */
  tenantAuthority?: ScanTenantAuthority;
}

const scanningReadRoles = rolesGranting('scanning:read');
const scanningManageRoles = rolesGranting('scanning:manage');
const passOperateRoles = rolesGranting('passes:operate');

/** Project tenant capabilities onto the scanner display's role hierarchy. */
export function tenantScanRole(
  authority: Extract<TenantPassWrite, { kind: 'session' }>,
): ScanRole | null {
  if (authority.roles.some((role) => scanningManageRoles.includes(role))) return 'manager';
  if (authority.roles.some((role) => passOperateRoles.includes(role))) return 'desk';
  if (authority.roles.some((role) => scanningReadRoles.includes(role))) return 'door';
  return null;
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

function settingsOf(ctx: ServiceContext, row: ScannerRow): ScannerSettings {
  try {
    const parsed = ScannerSettingsSchema.safeParse(JSON.parse(row.settings));
    if (parsed.success) return parsed.data;
  } catch {
    // falls through to the log below
  }
  ctx.log.error('scan.settings_invalid', { code: 'SCAN_SETTINGS_INVALID', scannerId: row.id });
  return LOCKED_SETTINGS;
}

export function scannerActor(
  ctx: ServiceContext,
  row: ScannerRow,
  mode: Mode,
  transport: 'cookie' | 'bearer',
  scope: {
    event: ScanEventRow | null;
    templateIds: string[];
    restricted?: boolean;
    valid?: boolean;
    assignment?: ScannerAssignmentSnapshot | null;
  },
): ScanActor {
  const settings = settingsOf(ctx, row);
  const invalidScannerScope = scope.valid === false;
  const restricted =
    scope.restricted === true ||
    invalidScannerScope ||
    row.eventId !== null ||
    scope.event !== null ||
    scope.templateIds.length > 0;
  return {
    principal: 'scanner',
    orgId: row.orgId,
    mode,
    actorKey: `s:${row.id}`,
    actor: { type: 'scanner', id: row.id },
    scanner: row,
    event: invalidScannerScope ? null : scope.event,
    templateIds: invalidScannerScope ? [] : scope.templateIds,
    scannerAssignment: scope.assignment ?? null,
    invalidScannerScope,
    timeZone: invalidScannerScope ? row.timeZone : (scope.event?.timeZone ?? row.timeZone),
    role: null,
    staff: null,
    settings: restricted ? { ...settings, acceptAllTemplates: false } : settings,
    name: row.name,
    terminal: transport === 'bearer',
  };
}

/** An invalid or conflicting scanner scope can never become unrestricted. */
export function denyInvalidScannerScope(actor: ScanActor): void {
  if (!actor.invalidScannerScope) return;
  actor.event = null;
  actor.templateIds = [];
  actor.settings = { ...actor.settings, acceptAllTemplates: false };
  if (actor.scanner) actor.timeZone = actor.scanner.timeZone;
}

export function adminActor(session: SessionAuth, mode: Mode, scope: ResolvedScope): ScanActor {
  return {
    principal: 'admin',
    orgId: scope.orgId,
    mode,
    actorKey: `u:${session.userId}`,
    actor: { type: 'user', id: session.userId },
    scanner: null,
    event: scope.event,
    templateIds: scope.templateIds,
    timeZone: scope.timeZone,
    role: 'manager',
    staff: null,
    settings: ADMIN_SETTINGS,
    name: 'Admin console',
    terminal: false,
  };
}

/** Sets the role once staff is known. A terminal runs its own role; nobody signs in on it. */
export function withRole(actor: ScanActor, staff: BoundStaff | null): ScanActor {
  actor.staff = staff;
  actor.role = actor.terminal
    ? actor.settings.roleWithoutSignIn
    : effectiveRole({
        principal: 'scanner',
        staffRole: staff?.role ?? null,
        settings: actor.settings,
      });
  return actor;
}
