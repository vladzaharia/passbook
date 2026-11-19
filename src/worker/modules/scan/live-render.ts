import { renderCustomerView } from '../../../passkit/template/scan-display/customer.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { ScanCustomerViewSchema } from '../../../shared/contracts/scan-customer.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { LiveRecipient } from './live-auth.ts';
import { type LiveRingRow, livePhotoUrl, redactedRow } from './live-ring.ts';
import { liveRowsStmt } from './repo-live-render.ts';
import { scanReadAuthority } from './repo-read-authority.ts';

const CUSTOMER_WINDOW_MS = 10_000;

/**
 * A recipient watches every scanner it lists, every scan of a session, event or zone it names, and
 * never its own screen. A customer screen sees only its scanners and sessions: never an event or a
 * zone, so it cannot receive traffic from beyond the counter in front of it.
 */
export function watches(recipient: LiveRecipient, entry: LiveRingRow) {
  const { watch, actor } = recipient;
  const source = entry.row.scannerId;
  if (actor.scanner === null || actor.scanner.id === source) return false;
  if (watch.allOrg || watch.scannerIds.includes(source)) return true;
  if (entry.sessionId && watch.sessionIds?.includes(entry.sessionId)) return true;
  if (actor.scanner.deviceRole === 'customer') return false;
  if (entry.eventId && watch.eventId === entry.eventId) return true;
  return (watch.zoneIds ?? []).some((zone) => entry.zoneIds?.includes(zone));
}

/** The occupancy fields a monitor of this role may read: counts for a door, who and how long from a desk. */
function monitorExtras(row: ScanLiveRow, role: ScanRole | null): Partial<ScanLiveRow> {
  const desk = role !== null && role !== 'door';
  return {
    ...(row.outCause === undefined ? {} : { outCause: row.outCause }),
    ...(row.overrideOf === undefined ? {} : { overrideOf: row.overrideOf }),
    ...(row.occupancy
      ? {
          occupancy: desk
            ? row.occupancy
            : { ...row.occupancy, via: null, stayMs: null, since: null },
        }
      : {}),
    ...(row.resolvedBy && desk ? { resolvedBy: row.resolvedBy } : {}),
  };
}

/**
 * The body a customer screen draws. A system view: the band, then the first name on ok and ready when
 * the pass is still visible and the session greets. The doc-named chips and panel ride only a visible
 * pass. No reason, staff, photo, pass id, count or other holder.
 */
function customerRow(
  recipient: LiveRecipient,
  entry: LiveRingRow,
  visible: boolean,
): ScanLiveRow | null {
  const { row } = entry;
  const settings = recipient.customer;
  const base = redactedRow(row, true);
  if (row.kind === 'undo') return base;
  if (row.kind === 'ready' && settings.showReady === false) return null;
  const screen = row.kind === 'ok' ? 'ok' : row.kind === 'ready' ? 'ready' : 'see_desk';
  const named = visible && screen !== 'see_desk' && row.holder ? row.holder : null;
  const view = renderCustomerView(
    named ? { v: 1, header: {}, holder: '{{pass.title}}' } : null,
    named ? { pass: { title: named, templateName: '' } } : {},
    {
      screen,
      ref: row.id,
      at: row.at,
      where: '',
      test: recipient.actor.mode === 'test',
      locale: 'en',
      timeZone: recipient.actor.timeZone,
      now: row.at,
      ...(settings.greet === undefined ? {} : { greet: settings.greet }),
      ...(settings.refusedLine === undefined ? {} : { refusedLine: settings.refusedLine }),
      direction: row.direction,
      event: entry.eventId !== null && entry.eventId !== undefined,
    },
  );
  const extras = visible && entry.customer && screen !== 'see_desk' ? entry.customer : null;
  const checked = ScanCustomerViewSchema.safeParse({
    ...view,
    ...extras,
    ...(settings.welcome ? { welcome: settings.welcome } : {}),
  });
  return {
    ...base,
    ...(row.replaces ? { replaces: row.replaces } : {}),
    customer: checked.success ? checked.data : view,
  };
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
  const visible = { ...redactedRow(row, false), ...monitorExtras(row, role), passId: row.passId };
  if (!role) return visible;
  const holder = entry.holderRoles.includes(role) && row.holder ? row.holder.slice(0, 40) : null;
  const photo =
    imageCurrent &&
    row.passId !== null &&
    actor.settings.showPhoto !== false &&
    entry.photoRoles.includes(role) &&
    (entry.validUntil === null || now <= entry.validUntil);
  const letIn =
    entry.overridable &&
    entry.scanId &&
    actor.scanner?.deviceRole === 'monitor' &&
    actor.settings.deskActions &&
    actor.role !== null;
  return {
    ...visible,
    ...(letIn && entry.scanId ? { scanId: entry.scanId } : {}),
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
    (entry) =>
      watches(recipient, entry) &&
      (!customer || (entry.row.presented && start - entry.row.at <= CUSTOMER_WINDOW_MS)),
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
      entry.row.passId !== null &&
      entry.gen !== null &&
      flag.scan_ok === 1 &&
      flag.pass_ok > 0 &&
      (entry.validUntil === null || now <= entry.validUntil);
    if (customer) {
      const body = customerRow(recipient, entry, live);
      if (body) out.push(body);
      return;
    }
    const role = actor.role ?? (flag.staff_ok === 1 ? entry.sourceRole : null);
    out.push(
      live
        ? visibleRow(recipient, entry, now, flag.pass_ok === 2, flag.staff_ok === 1)
        : { ...redactedRow(entry.row, false), ...monitorExtras(entry.row, role) },
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
