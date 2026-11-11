import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import {
  ScanSessionSchema,
  ScanStaffSearchSchema,
  ScanStaffSignInSchema,
} from '../../../shared/contracts/scan-session.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ConflictError, ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqualBytes } from '../../platform/ids.ts';
import { register } from '../../platform/openapi.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { type ScanActor, scanScannerCsrfProof, withRole } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { scanActorOf } from './guard.ts';
import {
  bindStaff,
  getScanner,
  type ScannerRow,
  scannerEpochsOf,
  unbindStaff,
} from './repo-device.ts';
import { staffSearchStmt } from './repo-session.ts';
import { getStaff } from './repo-staff.ts';
import { scanEpochsOf } from './scan-epochs.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { buildSession } from './session.ts';
import { boundStaff } from './staff-binding.ts';
import { checkPin } from './staff-pin.ts';

/** Staff bindings belong to paired scanner devices, not bearer terminals or admin sessions. */
function staffScanner(actor: ScanActor): ScannerRow {
  if (actor.principal !== 'scanner' || actor.terminal || !actor.scanner)
    throw new ForbiddenError(
      'Staff sign-in is only available on a paired scanner.',
      'STAFF_SIGN_IN_UNAVAILABLE',
    );
  return actor.scanner;
}

/**
 * Re-read the binding after a mutation, in case another staff change won the race. The mutation has
 * committed, so a capture that lost a race to a later change is rebuilt from the rows as they are now.
 */
async function staffSession(ctx: ServiceContext, actor: ScanActor) {
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
    if (scanner.deviceRole !== 'scan')
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

const RosterQuery = z.object({ q: z.string().trim().min(1).max(80) });

export function registerScanStaffRoutes(scanRoutes: OpenAPIHono<AppBindings>): void {
  register(
    scanRoutes,
    'scan',
    {
      method: 'get',
      path: '/staff',
      summary: 'Search the staff roster of this scanner',
      query: RosterQuery,
      response: ScanStaffSearchSchema,
    },
    async (c) => {
      const actor = scanActorOf(c);
      staffScanner(actor);
      if (!actor.settings.staffSignIn)
        throw new ForbiddenError(
          'Staff sign-in is not enabled on this scanner.',
          'STAFF_SIGN_IN_DISABLED',
        );
      const rows = await staffSearchStmt(c.env.DB, actor.orgId, c.req.valid('query').q).all<{
        id: string;
        name: string;
        role: ScanRole;
      }>();
      return c.json({ items: rows.results });
    },
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'post',
      path: '/staff',
      summary: 'Sign in staff on this scanner',
      body: ScanStaffSignInSchema,
      response: ScanSessionSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const actor = scanActorOf(c);
      const scanner = staffScanner(actor);
      if (!actor.settings.staffSignIn)
        throw new ForbiddenError(
          'Staff sign-in is not enabled on this scanner.',
          'STAFF_SIGN_IN_DISABLED',
        );
      const { staffId, pin } = c.req.valid('json');
      const staff = await getStaff(ctx.env.DB, actor.orgId, staffId);
      await checkPin(ctx, { scannerId: scanner.id, orgId: actor.orgId, staffId, staff, pin });
      const bound = actor.scanningSession;
      const sessionEpoch = scanEpochsOf(actor)?.session;
      if (!staff || staff.authEpoch === undefined || (bound && sessionEpoch?.id !== bound.id))
        throw new ConflictError(
          'The scanner or staff member changed. Try again.',
          'SCAN_STAFF_CHANGED',
        );
      await bindStaff(
        ctx,
        scanner,
        { id: staff.id, authEpoch: staff.authEpoch },
        bound && sessionEpoch ? { id: bound.id, configEpoch: sessionEpoch.config } : undefined,
      );
      const session = await staffSession(ctx, actor);
      const auth = c.var.auth;
      if (auth?.kind === 'scanner' && auth.transport === 'cookie')
        session.csrfToken = auth.csrfSecret;
      return c.json(session);
    },
  );

  register(
    scanRoutes,
    'scan',
    {
      method: 'delete',
      path: '/staff',
      summary: 'Sign out staff on this scanner',
      response: ScanSessionSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const actor = scanActorOf(c);
      await unbindStaff(ctx, staffScanner(actor));
      const session = await staffSession(ctx, actor);
      const auth = c.var.auth;
      if (auth?.kind === 'scanner' && auth.transport === 'cookie')
        session.csrfToken = auth.csrfSecret;
      return c.json(session);
    },
  );
}
