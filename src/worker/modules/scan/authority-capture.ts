import { type SqlValue, stmt } from '../../platform/db.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ScanActor } from './actor.ts';
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
  const add = (key: string, sql: string, params: SqlValue[]) => {
    at[key] = reads.push(stmt(db, sql, params)) - 1;
  };
  if (staff && scanner)
    add(
      'staff',
      `SELECT role, disabled_at, pin_hash, auth_epoch FROM scan_staff WHERE id=? AND org_id=?`,
      [staff.id, actor.orgId],
    );
  if (session)
    add(
      'session',
      `SELECT status, accepts, settings, time_zone, config_epoch FROM scanning_sessions
        WHERE id=? AND org_id=? AND mode=?`,
      [session.id, actor.orgId, actor.mode],
    );
  if (event)
    add(
      'event',
      `SELECT match_input, match_values, opens_at, closes_at, time_zone, capacity, reentry,
        archived_at, config_epoch,
        (SELECT json_group_array(template_id) FROM
          (SELECT template_id FROM scan_event_templates WHERE event_id=? ORDER BY template_id)) AS tpl
        FROM scan_events WHERE id=? AND org_id=? AND mode=?`,
      [event.id, event.id, actor.orgId, actor.mode],
    );
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
      ss.time_zone !== parent.time_zone
    )
      throw configChanged();
    epochs.session = { id: session.id, config: ss.config_epoch };
  }
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
  }>('event');
  if (event) {
    // The template set bumps the event's epoch, so the actor's scope must still be that set.
    const sameTemplates =
      !(scanner || actor.adminEventTemplates) ||
      ev?.tpl === JSON.stringify([...actor.templateIds].sort());
    if (
      !sameTemplates ||
      !ev ||
      ev.archived_at !== null ||
      ev.match_input !== event.matchInput ||
      ev.match_values !== event.matchValues ||
      ev.opens_at !== event.opensAt ||
      ev.closes_at !== event.closesAt ||
      ev.time_zone !== event.timeZone ||
      ev.capacity !== event.capacity ||
      (ev.reentry === 1) !== event.reentry
    )
      throw configChanged();
    epochs.events[event.id] = ev.config_epoch;
  }
  setScanEpochs(actor, epochs);
}
