import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { credentialGone, getScanner } from './repo-device.ts';
import { scanEpochsOf } from './scan-epochs.ts';

/** The presented scanner credential is gone or replaced: a moved credential epoch covers a rotated CSRF secret. */
export async function scannerCredentialLost(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<boolean> {
  const scanner = actor.scanner;
  if (actor.principal !== 'scanner' || !scanner) return false;
  if (await credentialGone(ctx.env.DB, scanner, ctx.clock.now())) return true;
  const captured = scanEpochsOf(actor)?.scanner?.credential;
  const fresh = await getScanner(ctx.env.DB, scanner.id);
  return !!fresh && captured !== undefined && fresh.credentialEpoch !== captured;
}
