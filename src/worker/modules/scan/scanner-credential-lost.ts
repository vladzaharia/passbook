import { AppError, ConflictError } from '../../platform/errors.ts';
import { safeEqualBytes } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { type ScanActor, scanScannerCsrfProof } from './actor.ts';
import { scannerExpired } from './auth-store.ts';
import { credentialGone, getScanner } from './repo-device.ts';

/**
 * The presented scanner credential no longer authenticates, as the guard would find on the next
 * request: its token was replaced (hash or lookup prefix), revoked or expired, it crossed the
 * terminal boundary, or its CSRF secret rotated. Only this unpairs a device. A pair code issued for
 * it, a mode move or a display/device switch also move the credential epoch; the token still works,
 * so that is configuration drift, not a lost credential.
 */
export async function scannerCredentialLost(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<boolean> {
  const scanner = actor.scanner;
  if (actor.principal !== 'scanner' || !scanner) return false;
  const now = ctx.clock.now();
  if (await credentialGone(ctx.env.DB, scanner, now)) return true;
  const fresh = await getScanner(ctx.env.DB, scanner.id);
  if (
    !fresh ||
    fresh.tokenPrefix !== scanner.tokenPrefix ||
    (fresh.kind === 'terminal') !== (scanner.kind === 'terminal') ||
    scannerExpired(fresh, now)
  )
    return true;
  // The guard keeps a proof of the secret, not the secret itself.
  if (!actor.scannerCsrfProof) return false;
  if (!fresh.csrfSecret) return true;
  const proof = await scanScannerCsrfProof(
    captureCredentialKeyEnv(ctx.env),
    scanner.id,
    fresh.csrfSecret,
  );
  const enc = new TextEncoder();
  return !safeEqualBytes(enc.encode(proof), enc.encode(actor.scannerCsrfProof));
}

const configChanged = () =>
  new ConflictError('Configuration changed. Reload and retry.', 'SCAN_CONFIG_CHANGED');

/**
 * A scanner grant refused as `actor` (the grant maps it to 401 `SCANNER_REPAIR`) unpairs only when
 * the credential is lost; any other credential-epoch move is configuration drift (409).
 */
export async function scannerRefusal(
  ctx: ServiceContext,
  actor: ScanActor,
  error: unknown,
  drift: () => AppError = configChanged,
): Promise<unknown> {
  if (
    error instanceof AppError &&
    error.code === 'SCANNER_REPAIR' &&
    actor.principal === 'scanner' &&
    !(await scannerCredentialLost(ctx, actor))
  )
    return drift();
  return error;
}
