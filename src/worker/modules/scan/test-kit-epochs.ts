import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { scanEpochsOf } from './scan-epochs.ts';

/**
 * The guard captures epochs with the actor; a hand-built one gets them here, as sealing, restoring
 * and grants need them (live source proofs, attachments, writes).
 */
export async function captureTestEpochs(ctx: ServiceContext, actor: ScanActor): Promise<void> {
  if (scanEpochsOf(actor)) return;
  const db = ctx.env.DB;
  const staff = actor.staff
    ? await first<{ pin_hash: string }>(db, 'SELECT pin_hash FROM scan_staff WHERE id = ?', [
        actor.staff.id,
      ])
    : null;
  // Some actor builders read the scanner without its epochs; the row has them.
  const row = actor.scanner
    ? await first<{ credential_epoch: number; config_epoch: number }>(
        db,
        'SELECT credential_epoch, config_epoch FROM scanners WHERE id = ?',
        [actor.scanner.id],
      )
    : null;
  await captureScanEpochs(
    db,
    actor,
    row ? { credential: row.credential_epoch, config: row.config_epoch } : undefined,
    staff?.pin_hash,
  );
}
