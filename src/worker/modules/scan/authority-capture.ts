import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ScanActor } from './actor.ts';
import { eventEpochStmt, sessionEpochStmt, staffEpochStmt } from './repo-authority-capture.ts';
import { type ScanAuthorityEpochs, setScanEpochs } from './scan-epochs.ts';
import { observedScanningSession } from './scanning-workspace-observation.ts';

const configChanged = () =>
  new ConflictError('Configuration changed. Reload and retry.', 'SCAN_CONFIG_CHANGED');

const staffChanged = () =>
  new ConflictError('Staff access changed. Sign in again.', 'SCAN_STAFF_CHANGED');

/**
 * A grant check was asked for an actor the guard never captured: a programming error, never a
 * refusal. It is a 500 (logged at error by the request handler) and cannot unpair a device.
 */
export const epochsMissing = () =>
  new AppError('SCAN_EPOCHS_MISSING', 500, 'Scan authority was not captured for this actor.');

/**
 * Capture every epoch the actor will be checked against. The scanner's two epochs were read in the
 * same row as its token hash, CSRF secret and configuration (`repo-device.ts`), so they belong to
 * exactly what the actor derived from. Staff, session and event epochs come from one D1 batch (one
 * snapshot) that also compares the columns the actor derived from: staff or configuration that
 * moved in between is a 409, never an unpair. Call it after all derivation, last.
 */
export async function captureScanEpochs(
  db: D1Database,
  actor: ScanActor,
  scannerEpochs?: { credential: number; config: number },
  /** `pin_hash` of the staff row the actor's staff came from (`auth_epoch` is not on that row). */
  staffPinHash?: string,
): Promise<void> {
  const { scanner, staff, scanningSession: session, event } = actor;
  const reads: D1PreparedStatement[] = [];
  const at: Record<string, number> = {};
  const add = (key: string, statement: D1PreparedStatement) => {
    at[key] = reads.push(statement) - 1;
  };
  if (staff && scanner) add('staff', staffEpochStmt(db, staff.id, actor.orgId));
  if (session) add('session', sessionEpochStmt(db, session.id, actor.orgId, actor.mode));
  // A mixed scope's events are captured with it: a scan narrows to one of them later.
  const scoped = [
    ...(event ? [{ event, templateIds: actor.templateIds }] : []),
    ...(actor.events ?? []),
  ];
  for (const [i, s] of scoped.entries())
    add(`event${i}`, eventEpochStmt(db, s.event.id, actor.orgId, actor.mode));
  const results = reads.length ? await db.batch(reads) : [];
  const row = <T>(key: string): T | undefined =>
    results[at[key] ?? -1]?.results?.[0] as T | undefined;

  const epochs: ScanAuthorityEpochs = { events: {} };
  if (scanner) {
    if (!scannerEpochs) throw epochsMissing();
    epochs.scanner = {
      id: scanner.id,
      credential: scannerEpochs.credential,
      config: scannerEpochs.config,
    };
  }
  const st = row<{
    role: string;
    disabled_at: number | null;
    pin_hash: string;
    auth_epoch: number;
  }>('staff');
  if (staff && scanner) {
    if (staffPinHash === undefined) throw epochsMissing();
    if (!st || st.disabled_at !== null || st.role !== staff.role || st.pin_hash !== staffPinHash)
      throw staffChanged();
    epochs.staff = { id: staff.id, auth: st.auth_epoch };
  }
  const ss = row<{
    status: string;
    accepts: string | null;
    settings: string;
    time_zone: string;
    hours: string | null;
    hold: string | null;
    config_epoch: number;
  }>('session');
  if (session) {
    const parent = observedScanningSession(actor)?.parent;
    if (
      !ss ||
      !parent ||
      ss.status !== session.status ||
      ss.accepts !== parent.accepts ||
      ss.settings !== parent.settings ||
      ss.time_zone !== parent.time_zone ||
      ss.hours !== parent.hours ||
      ss.hold !== parent.hold
    )
      throw configChanged();
    epochs.session = { id: session.id, config: ss.config_epoch };
  }
  for (const [i, { event: e, templateIds }] of scoped.entries()) {
    const ev = row<{
      match_input: string | null;
      match_values: string | null;
      opens_at: number;
      closes_at: number;
      time_zone: string;
      capacity: number | null;
      reentry: number;
      archived_at: number | null;
      config_epoch: number;
      tpl: string;
    }>(`event${i}`);
    // The template set bumps the event's epoch, so the actor's scope must still be that set.
    const sameTemplates =
      !(scanner || actor.adminEventTemplates || actor.events) ||
      ev?.tpl === JSON.stringify([...templateIds].sort());
    if (
      !sameTemplates ||
      !ev ||
      ev.archived_at !== null ||
      ev.match_input !== e.matchInput ||
      ev.match_values !== e.matchValues ||
      ev.opens_at !== e.opensAt ||
      ev.closes_at !== e.closesAt ||
      ev.time_zone !== e.timeZone ||
      ev.capacity !== e.capacity ||
      (ev.reentry === 1) !== e.reentry
    )
      throw configChanged();
    epochs.events[e.id] = ev.config_epoch;
  }
  setScanEpochs(actor, epochs);
}
