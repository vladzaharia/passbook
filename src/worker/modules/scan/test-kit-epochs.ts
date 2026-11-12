import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { getScanner } from './repo-device.ts';
import { getStaff } from './repo-staff.ts';
import { scanEpochsOf } from './scan-epochs.ts';

/**
 * The guard captures epochs with the actor; a hand-built one gets them here, as sealing, restoring
 * and grants need them (live source proofs, attachments, writes).
 */
export async function captureTestEpochs(ctx: ServiceContext, actor: ScanActor): Promise<void> {
  if (scanEpochsOf(actor)) return;
  const db = ctx.env.DB;
  const staff = actor.staff ? await getStaff(db, actor.orgId, actor.staff.id) : null;
  // Some actor builders read the scanner without its epochs; the row has them.
  const row = actor.scanner ? await getScanner(db, actor.scanner.id) : null;
  await captureScanEpochs(
    db,
    actor,
    row?.credentialEpoch !== undefined && row.configEpoch !== undefined
      ? { credential: row.credentialEpoch, config: row.configEpoch }
      : undefined,
    staff?.pinHash,
  );
}
