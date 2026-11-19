import { renderCustomerView } from '../../../passkit/template/scan-display/customer.ts';
import type { ScanRole } from '../../../shared/contracts/scan.ts';
import {
  type ScanLiveRow,
  ScanPublicCustomerViewSchema,
  type ScanPublicLiveRow,
} from '../../../shared/contracts/scan-setups.ts';
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

/** The public shape of a row: outcome, direction, place name and time. Never a person. */
export function publicRow(row: ScanLiveRow, customer: boolean): ScanPublicLiveRow {
  const { id, at, scannerId, kind, direction, label } = redactedRow(row, customer);
  return {
    id,
    at,
    scannerId,
    scannerName: customer ? '' : row.scannerName,
    kind,
    direction,
    label,
  };
}

/**
 * The body a customer screen draws: the band only. Never a name, chip, panel, line, reason, staff,
 * photo, pass id, count or other holder; the screen cannot correlate people.
 */
function customerRow(recipient: LiveRecipient, entry: LiveRingRow): ScanPublicLiveRow | null {
  const { row } = entry;
  const settings = recipient.customer;
  const base = publicRow(row, true);
  if (row.kind === 'undo') return base;
  if (row.kind === 'ready' && settings.showReady === false) return null;
  const screen = row.kind === 'ok' ? 'ok' : row.kind === 'ready' ? 'ready' : 'see_desk';
  const view = renderCustomerView(
    null,
    {},
    {
      screen,
      ref: row.id,
      at: row.at,
      where: '',
      test: recipient.actor.mode === 'test',
      locale: 'en',
      timeZone: recipient.actor.timeZone,
      now: row.at,
      greet: false,
      ...(settings.refusedLine === undefined ? {} : { refusedLine: settings.refusedLine }),
      direction: row.direction,
      event: entry.eventId !== null && entry.eventId !== undefined,
    },
  );
  const checked = ScanPublicCustomerViewSchema.safeParse({
    ...view,
    greet: null,
    chips: [],
    panel: null,
    lines: [],
    ...(settings.welcome ? { welcome: settings.welcome } : {}),
  });
  return {
    ...base,
    ...(row.replaces ? { replaces: row.replaces } : {}),
    ...(checked.success ? { customer: checked.data } : {}),
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
): Promise<(ScanLiveRow | ScanPublicLiveRow)[]> {
  const actor = recipient.actor;
  const monitor = actor.scanner?.deviceRole === 'monitor';
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
  const out: (ScanLiveRow | ScanPublicLiveRow)[] = [];
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
      const body = customerRow(recipient, entry);
      if (body) out.push(body);
      return;
    }
    if (monitor) {
      out.push(publicRow(entry.row, false));
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
): Promise<ScanLiveRow | ScanPublicLiveRow | null> {
  return (await liveRowsFor(ctx, recipient, [input]))[0] ?? null;
}
