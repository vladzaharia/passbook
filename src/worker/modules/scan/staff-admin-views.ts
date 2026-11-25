import { PlainLineSchema } from '../../../shared/contracts/common.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ConflictError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { captureConsoleFeed, consoleReadAuthority } from './feed-console-page.ts';
import type { ConsoleAuthority } from './feed-projection.ts';
import { isDonePasslessRow } from './feed-projection-history.ts';
import { toHistoryRow } from './history-row.ts';
import {
  createHistoryEvidenceCache,
  historyEvidenceOf,
  withKeyset,
} from './history-row-evidence.ts';
import { readOrgTimeZone } from './repo-org-clock.ts';
import { readStaffActivity, staffTimeZones } from './repo-staff-activity.ts';
import type { StaffPage } from './repo-staff-page.ts';
import { type AdminStaffResult, noStaff, staffItem } from './repo-staff-rows.ts';

const scannerNameSchema = PlainLineSchema(40);

/**
 * The staff page with each person's last scan, as one snapshot under the viewer's read fence. The
 * scanner's name shows only when its recorded proof, the pass and the viewer's role all allow it;
 * otherwise it reads "Scanner". A time zone that appeared since it was read is a 409.
 */
export async function staffViews(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
  page: StaffPage,
): Promise<AdminStaffResult> {
  let actor: Awaited<ReturnType<typeof captureConsoleFeed>>;
  try {
    actor = await captureConsoleFeed(ctx, session, authority);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return noStaff(false, true);
    throw error;
  }
  const now = ctx.clock.now();
  // One trip: the scanner zones and the org's own.
  const [zones, orgZone] = await Promise.all([
    staffTimeZones(ctx.env.DB, consoleReadAuthority(ctx, actor)),
    readOrgTimeZone(ctx.env.DB, actor.orgId),
  ]);
  const raws = await readStaffActivity(
    ctx.env.DB,
    consoleReadAuthority(ctx, actor),
    zones,
    now,
    page,
    orgZone,
  );
  const scope = raws[0];
  if (scope?.auth_ok !== 1) return noStaff(false, true);
  if (scope.snapshot_ok !== 1)
    throw new ConflictError('Scanner activity changed. Reload and retry.', 'SCAN_STAFF_CHANGED');
  const rows = raws.slice(0, page.limit);
  const scanned = rows.filter((raw) => raw.id !== null).map(toHistoryRow);
  const evidence = await withKeyset(ctx, scanned, () =>
    historyEvidenceOf(ctx, scanned, {
      role: actor.role,
      cache: createHistoryEvidenceCache(),
      requireAvailable: false,
    }),
  );
  return {
    authorized: true,
    snapshotCurrent: true,
    hasMore: raws.filter((raw) => raw.m_id !== null).length > page.limit,
    items: rows.flatMap((raw) => {
      const name = raw.scanner_name;
      const valid = raw.id !== null && name && scannerNameSchema.safeParse(name).data === name;
      const passless = scanned.some((row) => row.id === raw.id && isDonePasslessRow(row));
      const shown =
        valid && raw.id !== null
          ? passless || evidence.get(raw.id)?.policy?.scannerNameVisible(name)
          : false;
      const item = staffItem(raw, shown ? name : null);
      return item ? [item] : [];
    }),
  };
}
