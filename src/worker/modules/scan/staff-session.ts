import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { ConflictError, ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqualBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { type ScanActor, scanScannerCsrfProof, withRole } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { bindStaff, getScanner, scannerEpochsOf, unbindStaff } from './repo-device.ts';
import { staffSearchStmt } from './repo-session.ts';
import { getStaff } from './repo-staff.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { scannerRefusal } from './scanner-credential-lost.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { buildSession } from './session.ts';
import { boundStaff } from './staff-binding.ts';
import { checkPin } from './staff-pin.ts';
import { countNamedMiss, guardNamedDay } from './staff-pin-day.ts';
import { checkPinOnly } from './staff-pin-only.ts';
import { afterVerifiedPin } from './staff-pin-tag.ts';

/** Staff sign-in belongs to a paired scanner device; a terminal, a screen or an admin has none. */
function staffScanner(actor: ScanActor) {
  if (actor.principal !== 'scanner' || actor.terminal || !actor.scanner)
    throw new ForbiddenError(
      'Staff sign-in is only available on a paired scanner.',
      'STAFF_SIGN_IN_UNAVAILABLE',
    );
  return actor.scanner;
}

export function requireSignIn(actor: ScanActor) {
  const scanner = staffScanner(actor);
  if (!actor.settings.staffSignIn)
    throw new ForbiddenError(
      'Staff sign-in is not enabled on this scanner.',
      'STAFF_SIGN_IN_DISABLED',
    );
  return scanner;
}

/**
 * Re-read the binding after a mutation, in case another staff change won the race. The mutation has
 * committed, so a capture that lost a race to a later change is rebuilt from the rows as they are now.
 */
export async function staffSession(ctx: ServiceContext, actor: ScanActor): Promise<ScanSession> {
  const previous = staffScanner(actor);
  const keyEnv = captureCredentialKeyEnv(ctx.env);
  for (let attempt = 0; ; attempt++) {
    const scanner = await getScanner(ctx.env.DB, previous.id);
    if (
      !scanner ||
      scanner.orgId !== actor.orgId ||
      scanner.tokenHash !== previous.tokenHash ||
      scanner.revokedAt !== null
    )
      throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
    if (scanner.mode !== actor.mode)
      throw new ConflictError('Configuration changed. Reload and retry.', 'SCAN_CONFIG_CHANGED');
    if (
      scanner.deviceRole !== 'scan' &&
      !(scanner.deviceRole === 'monitor' && actor.settings.deskActions)
    )
      throw new ForbiddenError('This device is a screen.', 'SCREEN_ONLY');
    if (!scanner.csrfSecret || !actor.scannerCsrfProof)
      throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
    const proof = await scanScannerCsrfProof(keyEnv, scanner.id, scanner.csrfSecret);
    const encoder = new TextEncoder();
    if (!safeEqualBytes(encoder.encode(proof), encoder.encode(actor.scannerCsrfProof)))
      throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
    scanner.csrfSecret = null;
    const staff = scanner.staffId ? await getStaff(ctx.env.DB, actor.orgId, scanner.staffId) : null;
    actor.scanner = scanner;
    delete actor.scanningSession;
    await bindScanningSession(ctx, actor);
    withRole(actor, actor.settings.staffSignIn ? await boundStaff(ctx, scanner, staff) : null);
    try {
      // The sign-in changed who the actor is: capture the epochs of the new staff member and workspace.
      await captureScanEpochs(ctx.env.DB, actor, scannerEpochsOf(scanner), staff?.pinHash);
    } catch (error) {
      if (attempt < 3 && error instanceof ConflictError) continue;
      throw error;
    }
    return buildSession(ctx, actor);
  }
}

/** The people this scanner's org lets sign in, matching a name. */
export async function searchStaff(ctx: ServiceContext, actor: ScanActor, q: string) {
  requireSignIn(actor);
  const rows = await staffSearchStmt(ctx.env.DB, actor.orgId, q).all<{
    id: string;
    name: string;
    role: ScanRole;
  }>();
  return { items: rows.results, nextCursor: null };
}

/** Bind a staff member to the scanner after a PIN check; the session is read back as committed. */
export async function signInStaff(
  ctx: ServiceContext,
  actor: ScanActor,
  input: { staffId?: string | undefined; pin: string },
): Promise<ScanSession> {
  const scanner = requireSignIn(actor);
  const { staffId, pin } = input;
  // With no name, the PIN picks the person among the org's active staff.
  const staff = staffId
    ? await getStaff(ctx.env.DB, actor.orgId, staffId)
    : await checkPinOnly(ctx, scanner, pin);
  if (staffId) {
    // Only a person who exists is counted, so unknown names cannot grow the counters.
    if (staff) await guardNamedDay(ctx, scanner.id, staffId);
    await checkPin(ctx, { scannerId: scanner.id, orgId: actor.orgId, staffId, staff, pin }).catch(
      async (error: unknown) => {
        if (staff)
          await countNamedMiss(ctx, { orgId: actor.orgId, scannerId: scanner.id, staffId }, error);
        throw error;
      },
    );
  }
  const bound = actor.scanningSession;
  const sessionEpoch = scanEpochsOf(actor)?.session;
  if (!staff || staff.authEpoch === undefined || (bound && sessionEpoch?.id !== bound.id))
    throw new ConflictError(
      'The scanner or staff member changed. Try again.',
      'SCAN_STAFF_CHANGED',
    );
  await afterVerifiedPin(ctx, scanner, staff.id, pin);
  await bindStaff(
    ctx,
    scanner,
    { id: staff.id, authEpoch: staff.authEpoch },
    bound && sessionEpoch ? { id: bound.id, configEpoch: sessionEpoch.config } : undefined,
  ).catch(async (error: unknown) => {
    throw await scannerRefusal(ctx, actor, error);
  });
  return staffSession(ctx, actor);
}

export async function signOutStaff(ctx: ServiceContext, actor: ScanActor): Promise<ScanSession> {
  await unbindStaff(ctx, staffScanner(actor));
  return staffSession(ctx, actor);
}
