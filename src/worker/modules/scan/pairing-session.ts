import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scannerActor, withRole } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { readScannerScope } from './repo-scope.ts';
import { buildSession } from './session.ts';

/** Pairing returns the same complete session as a reload. */
export async function pairedSession(
  ctx: ServiceContext,
  scannerId: string,
  csrfToken: string | null,
): Promise<ScanSession> {
  const row = await getScanner(ctx.env.DB, scannerId);
  if (!row) throw new AppError('PAIRING_INVALID', 400, 'Code not valid. Ask for a new one.');
  const scope = await readScannerScope(ctx.env.DB, row, null);
  const session = await buildSession(
    ctx,
    withRole(scannerActor(ctx, row, row.mode, 'cookie', scope), null),
  );
  session.csrfToken = csrfToken;
  return session;
}
