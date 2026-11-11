import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { SqlValue } from '../../platform/db.ts';
import {
  type AppError,
  ConflictError,
  ForbiddenError,
  UnauthenticatedError,
  UnavailableError,
} from '../../platform/errors.ts';
import { safeEqualBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { credentialRefKeysetInitializeStmt } from '../passes/repo-credential-keyset.ts';
import { scanScannerCsrfProof } from './actor.ts';
import { planCounts } from './counts.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { undoWindowMinutes } from './outcome.ts';
import { credentialGone, getScanner } from './repo-device.ts';
import { orgNameStmt, STAFF_ROSTER_LIMIT, staffListStmt, userNameStmt } from './repo-session.ts';
import { sessionReadFencesCurrent } from './repo-session-authority.ts';
import {
  sessionCountGuardPredicate,
  sessionCountStatusStmt,
  unrestrictedSessionCountScope,
} from './repo-session-counts.ts';
import type { SessionCountAuthority } from './scanning-session-dto.ts';
import {
  scanningWorkspaceScopeFence,
  scanSessionCountAuthority,
  scanWorkspace,
} from './scanning-workspace.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { FORMATS, templatesOf } from './session-templates.ts';

/**
 * Why the session read lost its authority. Only a credential that moved on (revoked, expired, another
 * token or CSRF secret) unpairs the device. An admin-driven device is refused (403); any other drift, a moved
 * credential epoch included, is a 409 and the client refetches.
 */
/** The CSRF secret the guard proved is no longer the scanner's (the guard drops the secret itself). */
async function csrfRotated(ctx: ServiceContext, actor: ScanActor, id: string): Promise<boolean> {
  if (!actor.scannerCsrfProof) return false;
  const fresh = await getScanner(ctx.env.DB, id);
  if (!fresh?.csrfSecret) return true;
  const proof = await scanScannerCsrfProof(captureCredentialKeyEnv(ctx.env), id, fresh.csrfSecret);
  const enc = new TextEncoder();
  return !safeEqualBytes(enc.encode(proof), enc.encode(actor.scannerCsrfProof));
}

async function authorityLost(ctx: ServiceContext, actor: ScanActor): Promise<AppError> {
  const scanner = actor.scanner;
  if (actor.principal !== 'scanner')
    return new ForbiddenError('Your access changed. Reload and retry.', 'SCAN_ACCESS_CHANGED');
  if (
    !scanner ||
    (await credentialGone(ctx.env.DB, scanner, ctx.clock.now())) ||
    (await csrfRotated(ctx, actor, scanner.id))
  )
    return new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  return new ConflictError('Configuration changed. Reload and retry.', 'SCAN_CONFIG_CHANGED');
}

function stateOf(ctx: ServiceContext, actor: ScanActor): ScanSession['state'] {
  if (actor.invalidScannerScope) return 'unassigned';
  const now = ctx.clock.now();
  if (
    actor.scanner?.deviceRole === 'scan' &&
    actor.principal === 'scanner' &&
    actor.settings.staffSignIn &&
    actor.role === null
  )
    return 'staff_required';
  if (
    actor.scanner?.deviceRole === 'scan' &&
    actor.templateIds.length === 0 &&
    !actor.settings.acceptAllTemplates
  )
    return 'unassigned';
  if (actor.event && now < actor.event.opensAt) return 'not_open';
  if (actor.event && now > actor.event.closesAt) return 'closed';
  return 'ready';
}
/** Keep the count bootstrap and status statements below D1's bind limit. */
export function planSessionCountGuard(
  guard: { sql: string; params: readonly SqlValue[] },
  scope: { sql: string; params: readonly SqlValue[] },
): { sql: string; params: SqlValue[] } {
  if (guard.params.length + scope.params.length >= 99)
    throw new UnavailableError('Scanning counts are unavailable.', 'SCAN_COUNTS_UNAVAILABLE');
  return sessionCountGuardPredicate(guard, scope);
}

export async function buildSession(
  context: ServiceContext,
  sourceActor: ScanActor,
  dayStart?: number,
): Promise<ScanSession> {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(sourceActor);
  const authority = await scanSessionCountAuthority(ctx, actor);
  actor.credentialKeysetCommitment = authority.credentialKeysetCommitment;
  return sessionFor(ctx, actor, dayStart, false, authority);
}

async function sessionFor(
  ctx: ServiceContext,
  sourceActor: ScanActor,
  dayStart: number | undefined,
  forceUnassigned: boolean,
  countAuthority: SessionCountAuthority,
): Promise<ScanSession> {
  let actor = sourceActor;
  const scopedTemplates =
    forceUnassigned || actor.invalidScannerScope ? null : await templatesOf(ctx, actor);
  if (scopedTemplates === null) {
    const settings = { ...actor.settings, acceptAllTemplates: false, defaultActionId: null };
    delete settings.checkIn;
    delete settings.direction;
    actor = {
      ...actor,
      invalidScannerScope: true,
      event: null,
      templateIds: [],
      timeZone: actor.scanner?.timeZone ?? actor.timeZone,
      settings,
    };
  } else if (scopedTemplates.legacy.length > 0 && actor.settings.acceptAllTemplates)
    actor = { ...actor, settings: { ...actor.settings, acceptAllTemplates: false } };
  const screen = actor.scanner && actor.scanner.deviceRole !== 'scan';
  if (screen) actor = { ...actor, event: null, templateIds: [], staff: null };
  const templates = screen ? [] : (scopedTemplates?.templates ?? []);
  const db = ctx.env.DB;
  const guard = countAuthority.guardAt(ctx.clock.now());
  if (!guard) throw await authorityLost(ctx, sourceActor);
  const scope =
    scopedTemplates === null
      ? unrestrictedSessionCountScope()
      : scanningWorkspaceScopeFence(sourceActor);
  const countGuard = planSessionCountGuard(guard, scope);
  const counts =
    scopedTemplates === null ? null : planCounts(ctx, actor, dayStart, sourceActor, countGuard);
  const listStaff =
    scopedTemplates !== null &&
    actor.scanner?.deviceRole === 'scan' &&
    actor.principal === 'scanner' &&
    actor.settings.staffSignIn;
  const peopleStmt =
    actor.principal === 'admin'
      ? userNameStmt(db, actor.actor.id)
      : listStaff
        ? staffListStmt(db, actor.orgId)
        : null;
  const [results, undoWindow] = await Promise.all([
    db.batch([
      ...(counts
        ? [
            credentialRefKeysetInitializeStmt(
              db,
              countAuthority.credentialKeysetCommitment,
              countGuard,
            ),
            sessionCountStatusStmt(db, guard, scope, countAuthority.credentialKeysetCommitment),
          ]
        : []),
      orgNameStmt(db, actor.orgId),
      ...(peopleStmt ? [peopleStmt] : []),
      ...(counts?.stmts ?? []),
    ]),
    undoWindowMinutes(ctx),
  ]);
  const base = counts ? 2 : 0;
  if (counts) {
    const status = results[1]?.results?.[0] as
      | { authorized: number; scope_current: number; keyset: number }
      | undefined;
    if (status?.authorized !== 1) throw await authorityLost(ctx, sourceActor);
    if (status.scope_current !== 1)
      return sessionFor(ctx, sourceActor, dayStart, true, countAuthority);
    if (status.keyset !== 1)
      throw new UnavailableError(
        'Credential references are unavailable.',
        'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      );
  }
  const orgName = (results[base]?.results?.[0] as { name: string } | undefined)?.name ?? '';
  const peopleRows = peopleStmt ? (results[base + 1]?.results ?? []) : [];
  const countResults = results.slice(base + (peopleStmt ? 2 : 1));
  if (counts) {
    const today = (countResults[0]?.results?.[0] as { n?: unknown } | undefined)?.n;
    const managers = (countResults[1]?.results?.[0] as { has?: unknown } | undefined)?.has;
    const totals = countResults[2]?.results?.[0] as
      | { arrived?: unknown; inside?: unknown }
      | undefined;
    const expected =
      (countResults[3]?.results?.[0] as { n?: unknown } | undefined)?.n ??
      (countResults[4]?.results?.[0] as { n?: unknown } | undefined)?.n;
    if (
      typeof today !== 'number' ||
      !Number.isSafeInteger(today) ||
      today < 0 ||
      (managers !== 0 && managers !== 1) ||
      (actor.event &&
        (!totals ||
          typeof totals.arrived !== 'number' ||
          !Number.isSafeInteger(totals.arrived) ||
          totals.arrived < 0 ||
          typeof totals.inside !== 'number' ||
          !Number.isSafeInteger(totals.inside) ||
          totals.inside < 0 ||
          typeof expected !== 'number' ||
          !Number.isSafeInteger(expected) ||
          expected < 0))
    )
      throw new UnavailableError('Scanning counts are unavailable.', 'SCAN_COUNTS_UNAVAILABLE');
  }
  const read = counts
    ? await counts.read(countResults)
    : { counts: { today: 0, event: null, asOf: 0, configRev: 0 }, approvals: false };
  const formats = actor.settings.acceptAllTemplates
    ? Object.values(FORMATS)
    : [...new Set(templates.flatMap((t) => t.formats))];
  const allStaff = peopleRows as { id: string; name: string; role: ScanRole }[];
  const staffRows = allStaff.slice(0, STAFF_ROSTER_LIMIT);
  const staffTruncated = listStaff && allStaff.length > STAFF_ROSTER_LIMIT;
  if (staffTruncated)
    ctx.log.warn('scan.roster_truncated', { orgId: actor.orgId, code: 'SCAN_ROSTER_TRUNCATED' });
  const event = actor.event;
  const user = peopleRows[0] as { name: string | null; primary_email: string } | undefined;
  const workspace =
    scopedTemplates === null ? null : await scanWorkspace(ctx, actor, countAuthority);
  const fences = await sessionReadFencesCurrent(
    ctx,
    sourceActor,
    ctx.clock.now(),
    scopedTemplates?.releases ?? [],
    scopedTemplates?.legacy ?? [],
    {
      scopeRedacted: scopedTemplates === null,
      ...(counts ? { credentialKeysetCommitment: countAuthority.credentialKeysetCommitment } : {}),
    },
  );
  if (!fences.authorityCurrent || (!fences.stampsCurrent && !scopedTemplates))
    throw await authorityLost(ctx, sourceActor);
  if (!fences.stampsCurrent) return sessionFor(ctx, sourceActor, dayStart, true, countAuthority);
  return {
    workspace,
    principal: actor.principal,
    state: stateOf(ctx, actor),
    scanner: actor.scanner
      ? {
          id: actor.scanner.id,
          name: actor.scanner.name,
          kind: actor.scanner.kind,
          deviceRole: actor.scanner.deviceRole,
          mode: actor.mode,
          orgId: actor.orgId,
          orgName,
          timeZone: actor.timeZone,
          settings: actor.settings,
        }
      : null,
    admin:
      actor.principal === 'admin'
        ? {
            name: user?.name ?? user?.primary_email ?? 'Admin',
            orgs: [{ id: actor.orgId, name: orgName }],
          }
        : null,
    event: event
      ? {
          id: event.id,
          name: event.name,
          opensAt: event.opensAt,
          closesAt: event.closesAt,
          timeZone: event.timeZone,
          reentry: event.reentry,
          note: event.note,
        }
      : null,
    templates,
    formats,
    staff: actor.staff
      ? { id: actor.staff.id, name: actor.staff.name, role: actor.staff.role }
      : null,
    staffList: listStaff ? staffRows : null,
    ...(staffTruncated ? { staffTruncated: true } : {}),
    approvals: read.approvals,
    csrfToken: null,
    undoWindowMinutes: undoWindow,
    counts: read.counts,
  };
}
