import { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { ScanBrandingSchema, type ScanSession } from '../../../shared/contracts/scan-session.ts';
import { knownEmail } from '../../../shared/email.ts';
import {
  type AppError,
  ConflictError,
  ForbiddenError,
  UnauthenticatedError,
  UnavailableError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { planCounts } from './counts.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { undoWindowMinutes } from './outcome.ts';
import { scanAuthorizedStmt, scanReadAuthority, scanReadFence } from './repo-read-authority.ts';
import {
  orgBrandingStmt,
  orgNameStmt,
  STAFF_ROSTER_LIMIT,
  staffListStmt,
  userNameStmt,
} from './repo-session.ts';
import { scannerCredentialLost } from './scanner-credential-lost.ts';
import type { SessionReadAuthority } from './scanning-session-dto.ts';
import { scanSessionCountAuthority, scanWorkspace } from './scanning-workspace.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
import { FORMATS, templatesOf } from './session-templates.ts';

/**
 * Why the session read lost its authority. Only a lost credential (`scannerCredentialLost`) unpairs the
 * device. An admin-driven device is refused (403); any other drift, a moved credential epoch included, is
 * a 409 and the client refetches.
 */
async function authorityLost(ctx: ServiceContext, actor: ScanActor): Promise<AppError> {
  if (actor.principal !== 'scanner')
    return new ForbiddenError('Your access changed. Reload and retry.', 'SCAN_ACCESS_CHANGED');
  if (!actor.scanner)
    return new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  // The credential authenticated at the guard and is gone now: the same answer as every grant refusal.
  if (await scannerCredentialLost(ctx, actor))
    return new UnauthenticatedError('Pair this device again.', 'SCANNER_REPAIR');
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
export async function buildSession(
  context: ServiceContext,
  sourceActor: ScanActor,
  dayStart?: number,
): Promise<ScanSession> {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const actor = cloneObservedScanActor(sourceActor);
  return sessionFor(ctx, actor, dayStart, scanSessionCountAuthority(actor));
}

async function sessionFor(
  ctx: ServiceContext,
  sourceActor: ScanActor,
  dayStart: number | undefined,
  countAuthority: SessionReadAuthority,
): Promise<ScanSession> {
  let actor = sourceActor;
  const scopedTemplates = actor.invalidScannerScope ? null : await templatesOf(ctx, actor);
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
  const now = ctx.clock.now();
  // The cache write is under the strict fence: a paused or staffless actor reads but never fills.
  const counts =
    scopedTemplates === null
      ? null
      : planCounts(
          ctx,
          actor,
          dayStart,
          sourceActor,
          scanReadFence(scanReadAuthority(sourceActor, { now })),
        );
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
      scanAuthorizedStmt(db, countAuthority.at(now)),
      orgNameStmt(db, actor.orgId),
      orgBrandingStmt(db, actor.orgId),
      ...(peopleStmt ? [peopleStmt] : []),
      ...(counts?.stmts ?? []),
    ]),
    undoWindowMinutes(ctx),
  ]);
  if ((results[0]?.results?.[0] as { authorized?: number } | undefined)?.authorized !== 1)
    throw await authorityLost(ctx, sourceActor);
  const orgName = (results[1]?.results?.[0] as { name: string } | undefined)?.name ?? '';
  const storedBranding = OrgBrandingSchema.parse(
    JSON.parse((results[2]?.results?.[0] as { branding?: string } | undefined)?.branding ?? '{}'),
  );
  const branding = ScanBrandingSchema.parse({
    accent: storedBranding.accent ?? null,
    logo: storedBranding.logo ?? null,
  });
  const peopleRows = peopleStmt ? (results[3]?.results ?? []) : [];
  const countResults = results.slice(peopleStmt ? 4 : 3);
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
  return {
    workspace,
    principal: actor.principal,
    branding,
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
            name: user?.name ?? knownEmail(user?.primary_email) ?? 'Admin',
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
