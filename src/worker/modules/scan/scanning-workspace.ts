import type { ScanDeviceCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { reportedCapabilities } from '../../../shared/scan-surfaces.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { SqlValue } from '../../platform/db.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  UnauthenticatedError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { listMyOrgMemberships } from '../orgs/access.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import type { ScanActor } from './actor.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { scannerHasTemplates } from './repo-device.ts';
import { captureConfigurationScope } from './repo-scanner-configuration-scope.ts';
import { getConsoleScanner } from './repo-scanners.ts';
import { scanningDeviceRow, sessionWatchIds } from './repo-scanning-devices.ts';
import { scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { readScannerScope, readValidEventScope } from './repo-scope.ts';
import {
  packedScanAuthorityPredicate,
  sessionReadAuthorityPredicate,
} from './repo-session-authority.ts';
import { scannerCredentialLost } from './scanner-credential-lost.ts';
import {
  conflictsWithAllScope,
  deviceDto,
  effectiveSessionSettings,
  resolveSessionScope,
  type SessionCountAuthority,
  sessionDto,
} from './scanning-session-dto.ts';
import {
  captureObservedScanningSession,
  cloneObservedScanActor,
  observedScanningSession,
  recordObservedScanningSession,
} from './scanning-workspace-observation.ts';
import { commitReportedDevice } from './scanning-workspace-report.ts';

/** Do not return a reloaded view if its tenant changed since authorization. */
export function scopedScanningView<T extends { orgId: string }>(view: T, orgId: string): T {
  if (view.orgId !== orgId) throw new ForbiddenError();
  return view;
}

/** Merge tenant-scoped pages without ever querying an unscoped scanner list. */
export async function readableScanningPage<
  T extends { id: string },
  Q extends { orgId?: string | undefined; limit: number },
>(
  ctx: ServiceContext,
  auth: AuthContext,
  query: Q,
  list: (
    query: Q,
    authority: TenantPassWrite,
  ) => Promise<{ items: T[]; nextCursor: string | null }>,
) {
  if (auth.kind !== 'session') throw new ForbiddenError();
  const session = { ...auth, roles: [...auth.roles] };
  const selection = { ...query };
  if (selection.orgId) {
    const authority = await tenantAuthorityOf(ctx, session, selection.orgId, 'scanning:read');
    return list(selection, authority);
  }
  const memberships = await listMyOrgMemberships(ctx, session.userId);
  const orgs = memberships.filter((membership) =>
    membership.capabilities.includes('scanning:read'),
  );
  const pages = await Promise.all(
    orgs.map(async ({ orgId }) => {
      const authority = await tenantAuthorityOf(ctx, session, orgId, 'scanning:read');
      return list({ ...selection, orgId }, authority);
    }),
  );
  const rows = pages.flatMap((page) => page.items);
  rows.sort((a, b) => (a.id === b.id ? 0 : a.id > b.id ? -1 : 1));
  const items = rows.slice(0, selection.limit);
  return {
    items,
    nextCursor:
      rows.length > selection.limit || pages.some((page) => page.nextCursor !== null)
        ? (items.at(-1)?.id ?? null)
        : null,
  };
}

/** Capture the original actor proof and key ring for presence-bearing session counts. */
export async function scanSessionCountAuthority(
  context: ServiceContext,
  sourceActor: ScanActor,
  originalKeyset?: string,
): Promise<SessionCountAuthority> {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(sourceActor);
  const credentialKeysetCommitment =
    originalKeyset === undefined ? await credentialRefKeysetCommitment(ctx.env) : originalKeyset;
  // Credential, configuration and staff changes are epoch comparisons inside the predicate; a CSRF
  // secret cannot change without a credential epoch bump.
  const guardAt = (now: number) => {
    const authority = packedScanAuthorityPredicate(
      actor,
      sessionReadAuthorityPredicate(actor, now),
    );
    return authority.sql === '0' ? null : authority;
  };
  const guard = guardAt(ctx.clock.now());
  if (!guard)
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  return {
    orgId: actor.orgId,
    mode: actor.mode,
    sessionId: actor.scanningSession?.id,
    credentialKeysetCommitment,
    guard,
    guardAt,
  };
}
/** Fence every original workspace scope row and release in the count transaction. */
export function scanningWorkspaceScopeFence(actor: ScanActor): { sql: string; params: SqlValue[] } {
  // Scanner, session and event configuration are epoch comparisons in the read predicate.
  return actor.scanningSession && !observedScanningSession(actor)
    ? { sql: '0', params: [] }
    : { sql: '1', params: [] };
}

export async function bindScanningSession(ctx: ServiceContext, actor: ScanActor) {
  if (!actor.scanner) return;
  // Some callers construct an actor without reading its scanner scope first.
  if (actor.scanner.eventId !== null && !actor.event && !actor.invalidScannerScope) {
    const pinned = await readValidEventScope(
      ctx.env.DB,
      actor.orgId,
      actor.mode,
      actor.scanner.eventId,
    );
    if (pinned) {
      actor.event = pinned.event;
      actor.templateIds = pinned.templateIds;
    } else {
      actor.invalidScannerScope = true;
    }
  }
  const parent = await scanningSessionForDevice(ctx.env.DB, actor.orgId, actor.scanner.id);
  if (!parent) {
    if (actor.invalidScannerScope) {
      actor.event = null;
      actor.templateIds = [];
      actor.settings = { ...actor.settings, acceptAllTemplates: false };
    } else if (
      actor.scanner.eventId !== null ||
      actor.templateIds.length > 0 ||
      (actor.settings.acceptAllTemplates &&
        (await scannerHasTemplates(ctx.env.DB, actor.scanner.id)))
    ) {
      actor.settings = { ...actor.settings, acceptAllTemplates: false };
    }
    return;
  }
  if (parent.mode !== actor.mode)
    throw new ForbiddenError('Open the device in its session’s mode.', 'SCANNING_SESSION_MODE');
  const binding = { id: parent.id, status: parent.status, updatedAt: parent.updated_at };
  actor.scanningSession = binding;
  const device = await scanningDeviceRow(ctx.env.DB, actor.orgId, actor.scanner.id);
  const settings = effectiveSessionSettings(parent, device);
  if (!device || device.session_id !== parent.id || !settings) {
    ctx.log.error('scanning.settings_invalid', {
      orgId: actor.orgId,
      sessionId: parent.id,
      code: 'SCANNING_SESSION_SETTINGS_INVALID',
    });
    throw new ForbiddenError(
      'Correct this scanning session’s settings in Scanning.',
      'SCANNING_SESSION_SETTINGS_INVALID',
    );
  }
  const scanner = await getConsoleScanner(ctx.env.DB, actor.scanner.id);
  const captured = scanner
    ? await captureConfigurationScope(ctx.env.DB, actor.orgId, actor.mode, {
        scanner,
        session: parent,
      })
    : null;
  // Re-evaluate the scanner scope after capturing its heads; actors may have been
  // constructed from a scope read before this session was bound.
  if (!scanner || !(await readScannerScope(ctx.env.DB, scanner, null)).valid)
    actor.invalidScannerScope = true;
  const scope = await resolveSessionScope(ctx, parent);
  const conflict = await conflictsWithAllScope(ctx, actor.scanner, scope, settings);
  if (conflict || !scope.valid) actor.invalidScannerScope = true;
  const denied = actor.invalidScannerScope === true;
  actor.settings =
    scope.restricted || denied ? { ...settings, acceptAllTemplates: false } : settings;
  actor.event = denied ? null : scope.event;
  actor.templateIds = denied ? [] : scope.templateIds;
  actor.timeZone = actor.event?.timeZone ?? parent.time_zone;
  recordObservedScanningSession(binding, {
    parent,
    device,
    accepts: JSON.stringify(scope.accepts),
    scope: captured,
  });
}
export async function scanWorkspace(
  context: ServiceContext,
  sourceActor: ScanActor,
  authority: SessionCountAuthority,
) {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(sourceActor);
  if (!actor.scanner || !actor.scanningSession) return null;
  const observed = captureObservedScanningSession(actor);
  // A scope that is no longer valid is configuration, not credential: the workspace answers with the
  // restriction dropped (below) and the device stays paired.
  if (!observed)
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  const scope = scanningWorkspaceScopeFence(actor);
  const guardAt = (now: number) => {
    const guard = authority.guardAt(now);
    return !guard || scope.sql === '0'
      ? null
      : {
          sql: `(${guard.sql}) AND (${scope.sql})`,
          params: [...guard.params, ...scope.params],
        };
  };
  const guard = guardAt(ctx.clock.now());
  if (!guard)
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  const session = await sessionDto(ctx, observed.parent, { ...authority, guard, guardAt }).catch(
    async (error: unknown) => {
      // A lost credential unpairs the device; any other refusal keeps the generic not-found.
      if (
        error instanceof AppError &&
        error.code === 'SCANNING_SESSION_NOT_FOUND' &&
        (await scannerCredentialLost(ctx, sourceActor))
      )
        throw new UnauthenticatedError('Pair this device again.', 'SCANNER_REPAIR');
      throw error;
    },
  );
  const current =
    JSON.stringify(session.accepts) === observed.accepts &&
    !!session.settings.acceptAllTemplates === !!actor.settings.acceptAllTemplates;
  return {
    session: current
      ? session
      : { ...session, accepts: null, settings: { ...session.settings, acceptAllTemplates: false } },
    device: deviceDto(
      observed.device,
      ctx.clock.now(),
      current ? actor.settings : { ...actor.settings, acceptAllTemplates: false },
    ),
  };
}
export async function reportScanDevice(
  context: ServiceContext,
  sourceActor: ScanActor,
  raw: ScanDeviceCapabilities,
) {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(sourceActor);
  if (!actor.scanner) return null;
  const observed = observedScanningSession(actor);
  if (!observed) {
    const device = await scanningDeviceRow(ctx.env.DB, actor.orgId, actor.scanner.id);
    if (!device) return null;
    throw new ConflictError(
      'This device changed. Reload and try again.',
      'SCANNING_DEVICE_CHANGED',
    );
  }
  const capabilities = reportedCapabilities(raw);
  const credentialKeysetCommitment = await credentialRefKeysetCommitment(ctx.env);
  await commitReportedDevice(ctx, actor, observed, capabilities, bindScanningSession);
  const authority = await scanSessionCountAuthority(ctx, actor, credentialKeysetCommitment);
  return scanWorkspace(ctx, actor, authority);
}
export async function sessionScreenWatch(ctx: ServiceContext, orgId: string, scannerId: string) {
  const parent = await scanningSessionForDevice(ctx.env.DB, orgId, scannerId);
  if (!parent || parent.id === scannerId) return null;
  return {
    scannerIds: await sessionWatchIds(ctx.env.DB, orgId, parent.id, parent.mode),
    allOrg: false,
  };
}
