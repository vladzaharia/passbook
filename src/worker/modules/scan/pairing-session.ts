import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { AppError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { denyInvalidScannerScope, scannerActor, scanScannerCsrfProof, withRole } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { getScanner, scannerEpochsOf } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { getStaff } from './repo-staff.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { buildSession } from './session.ts';
import { boundStaff } from './staff-binding.ts';

/** Pairing returns the same complete session as a reload. */
export async function pairedSession(
  context: ServiceContext,
  scannerId: string,
  csrfToken: string | null,
  /** A staff binding made since pairing (an unlock) is part of the session. */
  withStaff = false,
): Promise<ScanSession> {
  const ctx = { ...context, env: snapshotCredentialEnv(context.env) };
  const row = await getScanner(ctx.env.DB, scannerId);
  if (!row || !csrfToken)
    throw new AppError('PAIRING_INVALID', 400, 'Code not valid. Ask for a new one.');
  // The CSRF secret is checked once here, against the row just read: it is part of the credential.
  if (!row.csrfSecret || !(await safeEqual(csrfToken, row.csrfSecret)))
    throw new UnauthenticatedError('Pair this scanner to continue.', 'SCANNER_UNAUTHENTICATED');
  const scope = await readScannerScope(ctx.env.DB, row, null);
  const actor = scannerActor(ctx, { ...row, csrfSecret: null }, row.mode, 'cookie', scope);
  actor.scannerCsrfProof = await scanScannerCsrfProof(ctx.env, scannerId, csrfToken);
  await bindScanningSession(ctx, actor);
  denyInvalidScannerScope(actor);
  // The epochs are read in the row that verified the credential; capture them last, after derivation.
  const staff =
    withStaff && row.staffId && actor.settings.staffSignIn
      ? await getStaff(ctx.env.DB, row.orgId, row.staffId)
      : null;
  withRole(actor, staff ? await boundStaff(ctx, actor.scanner ?? row, staff) : null);
  await captureScanEpochs(ctx.env.DB, actor, scannerEpochsOf(row), staff?.pinHash);
  const session = await buildSession(ctx, actor);
  session.csrfToken = csrfToken;
  return session;
}
