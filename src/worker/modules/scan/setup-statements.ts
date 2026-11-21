import type { z } from 'zod';
import type { ScannerSettings } from '../../../shared/contracts/scan.ts';
import { ScannerSettingsSchema } from '../../../shared/contracts/scan.ts';
import type { CreateScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import type { AdmitsInput } from '../../../shared/contracts/scanners.ts';
import type { Grant } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { getUser } from '../users/repo.ts';
import { DEFAULT_SETTINGS } from './dto-console.ts';
import { createPairing, hashPairCode, newPairCode, PAIR_TTL_MS, type Pairing } from './pairing.ts';
import { TERMINAL_TTL_MS } from './pairing-token.ts';
import { audited, eventsOpen, scopeTemplatesUsable, sessionEpoch } from './repo-admin-grant.ts';
import { addScannerTemplates, addSetupInsert } from './repo-admin-unguarded.ts';
import { addScannerInsert } from './repo-scanners.ts';
import { requirePairingAuthority } from './repo-scanners-pair.ts';
import type { ScanningSessionRow } from './repo-scanning-sessions.ts';
import { acceptedTemplateIds, type CheckedAdmits, checkAccepts } from './scanner-validation.ts';
import { loadScanner } from './scanner-views.ts';
import { addEnrollment, type DeviceEnrollment } from './scanning-enrollment.ts';
import type { SetupCapture } from './setup-capture.ts';
import { checkWatch } from './setup-watch.ts';

export const SETUP_CODES = { config: 'SCANNER_CHANGED', lineage: 'SCANNER_CHANGED' } as const;

/** A session's device setup takes the session's admits, which may mix events and templates. */
export type CreateSetup = Omit<z.infer<typeof CreateScannerSetupSchema>, 'accepts'> & {
  accepts?: AdmitsInput | null;
};

export function roleAllowed(kind: CreateSetup['kind'], role: CreateSetup['deviceRole']) {
  if ((kind === 'terminal' && role !== 'scan') || (kind === 'display' && role === 'scan'))
    throw new ValidationError('Choose a role this device supports.', [], 'SCANNER_ROLE_INVALID');
}

export function setupConflict(error: unknown): never {
  const info = classifyD1Error(error);
  if (info?.kind === 'unique' && /scanners\.name|scanners_org_name/.test(info.detail))
    throw new ConflictError('Another scanner already has that name.', 'SCANNER_NAME_TAKEN');
  if (info?.kind === 'unique')
    throw new ConflictError(
      'A setup with this name or admin already exists.',
      'SCANNER_SETUP_EXISTS',
    );
  throw error;
}

/** The code of a device made without one, as its own commit (the routes: it takes its own authority check). */
export async function issuePairing(
  ctx: ServiceContext,
  capture: SetupCapture,
  input: CreateSetup,
  id: string,
): Promise<Pairing | null> {
  if (input.adminUserId || input.kind === 'terminal') return null;
  return createPairing(
    ctx,
    capture.userId,
    await loadScanner(ctx, id),
    capture.origin,
    capture.authority,
  );
}

export interface SetupPlan {
  id: string;
  input: CreateSetup;
  enrollment: DeviceEnrollment | undefined;
  accepts: CheckedAdmits | null;
  settings: ScannerSettings;
  /** The grant's checks, without the device slot: see `slotChecks`. */
  checks: Check[];
  /** The one-time pairing code, issued with the row; null for a terminal or an admin's own browser. */
  pairing: (Pairing & { hash: string }) | null;
}

/**
 * The reads and rules of a device create: the org is active, the role, admin owner and watch are
 * valid, and the admitted events and templates are usable (an event the batch creates earlier is
 * usable without a check). A device joining a session names it as `parent`; one made in the same
 * batch has no epoch to check. The pairing code and its hash are made here. Nothing is written.
 */
export async function planSetup(
  ctx: ServiceContext,
  input: CreateSetup,
  capture: SetupCapture,
  enrollment?: DeviceEnrollment,
  parent?: ScanningSessionRow,
  /** Issue the code with the row (a batch). The per-object routes keep it a step of its own: `issuePairing`. */
  pairNow = true,
): Promise<SetupPlan> {
  const { userId, authority, orgId, mode } = capture;
  const { kind, deviceRole } = input;
  if (
    enrollment &&
    (!parent ||
      parent.id !== enrollment.sessionId ||
      parent.org_id !== orgId ||
      parent.mode !== mode)
  )
    throw new ConflictError(
      'This session changed. Reload and try again.',
      'SCANNING_SESSION_CHANGED',
    );
  if (!(await orgIsActive(ctx.env.DB, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  roleAllowed(kind, deviceRole);
  if (input.adminUserId) {
    // An admin setup is the caller's own; naming another user would expose their name and email.
    if (input.adminUserId !== userId)
      throw new ValidationError(
        'An admin setup belongs to the admin who creates it.',
        [{ path: 'adminUserId', message: 'Use your own account.' }],
        'SCANNER_ADMIN_USER',
      );
    const owner = await getUser(ctx.env.DB, input.adminUserId);
    if (owner?.status !== 'active')
      throw new NotFoundError('Admin user not found.', 'USER_NOT_FOUND');
    if (kind !== 'device')
      throw new ValidationError('Admin sign-in uses a browser device.', [], 'SCANNER_ADMIN_ROLE');
  }
  if (!enrollment) await checkWatch(ctx, orgId, mode, deviceRole, input.watch);
  // A device joining a session inherits its templates: archived ones already there stay usable.
  const attached = parent ? acceptedTemplateIds(parent.accepts) : [];
  const accepts = input.accepts
    ? await checkAccepts(ctx, orgId, mode, input.accepts, attached, capture.events)
    : null;
  const settings = ScannerSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...input.settings,
    acceptAllTemplates: accepts === null,
  });
  if (settings.checkIn?.eventId)
    await checkAccepts(ctx, orgId, mode, { eventId: settings.checkIn.eventId }, [], capture.events);
  const made = (id: string | null | undefined) => (id && capture.events.has(id) ? null : id);
  const pairable = pairNow && !input.adminUserId && kind !== 'terminal';
  if (pairable) requirePairingAuthority(authority, userId, orgId);
  const code = pairable ? newPairCode() : null;
  const pairing =
    code === null
      ? null
      : {
          code,
          url: `${capture.origin}/scan#pair=${code}`,
          expiresAt: ctx.clock.now() + PAIR_TTL_MS,
          hash: await hashPairCode(ctx.env, code),
        };
  capture.newScanners += 1;
  return {
    id: ctx.ids.id(),
    input,
    enrollment,
    accepts,
    settings,
    pairing,
    checks: [
      ...(parent && !capture.sessions.has(parent.id)
        ? [sessionEpoch(parent.id, parent.config_epoch)]
        : []),
      ...eventsOpen([...(accepts?.eventIds ?? []).map(made), made(settings.checkIn?.eventId)]),
      ...scopeTemplatesUsable(accepts?.templateIds ?? [], attached),
    ],
  };
}

/**
 * The scanner row (with its pairing code hash and expiry), its template links, setup row, session
 * membership or own session, and the audit rows of the setup and of the pairing. The code goes
 * back to the caller and nowhere else. A duplicate name fails the batch: classify with `conflict`.
 */
export function setupStatements(
  g: Grant,
  ctx: ServiceContext,
  plan: SetupPlan,
  capture: SetupCapture,
): { id: string; pairing: Pairing | null } {
  const { id, input, enrollment, accepts, settings, pairing } = plan;
  const { userId, orgId } = capture;
  const { kind, deviceRole } = input;
  const now = ctx.clock.now();
  addScannerInsert(g, {
    id,
    kind,
    deviceRole,
    name: input.name,
    eventId: accepts?.eventId ?? null,
    settings: JSON.stringify(settings),
    timeZone: input.timeZone,
    expiresAt: kind === 'terminal' ? now + TERMINAL_TTL_MS : null,
    createdBy: userId,
    now,
    ...(pairing ? { pair: { hash: pairing.hash, expiresAt: pairing.expiresAt } } : {}),
  });
  addScannerTemplates(g, id, accepts?.templateIds ?? []);
  addSetupInsert(g, id, capture.mode, input.adminUserId ?? null, input.watch);
  addEnrollment(ctx, g, id, userId, input, settings, enrollment);
  g.add(
    audited(g, ctx, {
      orgId,
      actorType: 'user',
      actorId: userId,
      action: 'scanner.setup_create',
      targetType: 'scanner',
      targetId: id,
      detail: { kind, deviceRole, adminSession: !!input.adminUserId },
    }),
  );
  if (pairing)
    g.add(
      audited(g, ctx, {
        orgId,
        actorType: 'user',
        actorId: userId,
        action: 'scanner.pairing_create',
        targetType: 'scanner',
        targetId: id,
        detail: { expiresAt: pairing.expiresAt },
      }),
    );
  return {
    id,
    pairing: pairing && { code: pairing.code, url: pairing.url, expiresAt: pairing.expiresAt },
  };
}
