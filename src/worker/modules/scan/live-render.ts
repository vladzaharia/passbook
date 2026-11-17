import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { LiveRecipient } from './live-auth.ts';
import { type LiveRingRow, livePhotoUrl, redactedRow } from './live-ring.ts';
import { liveRowsStmt } from './repo-live-render.ts';
import { scanReadAuthority } from './repo-read-authority.ts';

const CUSTOMER_WINDOW_MS = 10_000;

/** A recipient watches every source it lists, and never its own screen. */
export function watches(recipient: LiveRecipient, source: string) {
  return (
    recipient.actor.scanner !== null &&
    recipient.actor.scanner.id !== source &&
    (recipient.watch.allOrg || recipient.watch.scannerIds.includes(source))
  );
}

/**
 * What one recipient may see of a ring row once the scan and pass are known to be current: the
 * pass id, the holder's name only to a role whose own title for the holder is the source's (a
 * staffless monitor reads as the source), and a photo link only to a role the source's photo policy
 * shows and only while the pass image is the one the scan saw. A customer screen never gets identity.
 */
function visibleRow(
  recipient: LiveRecipient,
  entry: LiveRingRow,
  now: number,
  imageCurrent: boolean,
  staffOk: boolean,
): ScanLiveRow {
  const { row } = entry;
  const actor = recipient.actor;
  // A staffless monitor reads with the source's role while the source's staff binding still holds.
  const role = actor.role ?? (staffOk ? entry.sourceRole : null);
  const visible = { ...redactedRow(row, false), passId: row.passId };
  if (!role) return visible;
  const holder = entry.holderRoles.includes(role) && row.holder ? row.holder.slice(0, 40) : null;
  const photo =
    imageCurrent &&
    row.passId !== null &&
    actor.settings.showPhoto !== false &&
    entry.photoRoles.includes(role) &&
    (entry.validUntil === null || now <= entry.validUntil);
  return {
    ...visible,
    holder,
    photoUrl: photo && row.passId ? livePhotoUrl(actor, row.passId, row.id) : null,
  };
}

/**
 * Render ring rows for one recipient. One D1 statement re-checks the recipient's authority, each
 * row's scan and each row's pass; a row that fails any part is delivered as its redacted shape, and
 * nothing at all when the recipient's own authority fails.
 */
export async function liveRowsFor(
  ctx: ServiceContext,
  recipient: LiveRecipient,
  inputs: readonly LiveRingRow[],
): Promise<ScanLiveRow[]> {
  const actor = recipient.actor;
  const customer = actor.scanner?.deviceRole === 'customer';
  const start = ctx.clock.now();
  const entries = inputs.filter(
    ({ row }) =>
      watches(recipient, row.scannerId) &&
      (!customer || (row.presented && start - row.at <= CUSTOMER_WINDOW_MS)),
  );
  if (!entries.length) return [];
  const auth = scanReadAuthority(actor, { now: start, read: { stafflessMonitor: true } });
  const result = await liveRowsStmt(ctx.env.DB, auth, actor, entries).all<{
    i: number;
    scan_ok: number;
    pass_ok: number;
    staff_ok: number;
  }>();
  if (!result.success) return [];
  const flags = new Map(result.results.map((r) => [r.i, r]));
  const now = ctx.clock.now();
  const out: ScanLiveRow[] = [];
  entries.forEach((entry, i) => {
    const flag = flags.get(i);
    if (!flag || (customer && now - entry.row.at > CUSTOMER_WINDOW_MS)) return;
    const live =
      !customer &&
      entry.row.passId !== null &&
      entry.gen !== null &&
      flag.scan_ok === 1 &&
      flag.pass_ok > 0 &&
      (entry.validUntil === null || now <= entry.validUntil);
    out.push(
      live
        ? visibleRow(recipient, entry, now, flag.pass_ok === 2, flag.staff_ok === 1)
        : redactedRow(entry.row, customer),
    );
  });
  return out;
}

/** A single live event goes through the same statement as catch-up. */
export async function liveRowFor(
  ctx: ServiceContext,
  recipient: LiveRecipient,
  input: LiveRingRow,
): Promise<ScanLiveRow | null> {
  return (await liveRowsFor(ctx, recipient, [input]))[0] ?? null;
}
