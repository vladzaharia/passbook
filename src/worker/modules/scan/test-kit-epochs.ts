import { saveOrgSettings, TEST_NOW } from '../../../../test/helpers/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { getScanner, scannerEpochsOf } from './repo-device.ts';
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
  await captureScanEpochs(db, actor, row ? scannerEpochsOf(row) : undefined, staff?.pinHash);
}

/** Scan fixtures read their hours on a UTC clock; the unset-zone default has its own tests. */
export const pinOrgClock = (db: D1Database, orgId: string) =>
  saveOrgSettings(db, orgId, { 'org.timeZone': 'UTC' }, TEST_NOW);
