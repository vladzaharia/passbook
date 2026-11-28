import { type Grant, grant } from '../../platform/authority.ts';
import { exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { maxNow } from '../../platform/authority-expr.ts';
import { type GrantPart, writePart } from '../../platform/authority-include.ts';
import { all, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { AuditEntry } from '../audit/types.ts';
import { RACE_DEVICE_DAY_CLEAR } from './race-tags.ts';
import { type ScannerRow, scannerEpochsOf } from './repo-device.ts';
import { STAFF_CODES } from './staff-statements.ts';

type Db = D1Database;

/** The person's tag, reset flag and the record of the PIN the server issued, org-scoped. */
export const pinTagStateStatement = (db: Db, orgId: string, id: string) =>
  stmt(
    db,
    `SELECT pin_tag, pin_reset_required, pin_issued_at, pin_issued_binding, pin_issue_repeats
     FROM scan_staff WHERE id = ? AND org_id = ?`,
    [id, orgId],
  );

/** The active person who has this tag. */
export const staffWithTagStatement = (db: Db, orgId: string, tag: string) =>
  stmt(db, 'SELECT id FROM scan_staff WHERE org_id = ? AND pin_tag = ? AND disabled_at IS NULL', [
    orgId,
    tag,
  ]);

/**
 * A grant of the paired scanner for the bookkeeping of a PIN it saw: the tag and the reset flag are
 * volatile columns, so no epoch moves and no role, PIN hash or disabled time can change with them.
 */
export const pinStateGrant = (ctx: ServiceContext, scanner: ScannerRow): Grant =>
  grant(ctx, {
    purpose: 'org_mode.scan.staff.pin_state',
    principal: {
      kind: 'scanner',
      scannerId: scanner.id,
      credentialEpoch: scannerEpochsOf(scanner).credential,
    },
    checks: [exactlyOne('scanners', { id: scanner.id, revoked_at: null }, undefined, 'config')],
    target: scanner.id,
    codes: STAFF_CODES,
  });

/** Fills a tag that is not set yet; a tag some other active person has is a unique error on commit. */
export const fillPinTag = (g: Grant, id: string, tag: string) =>
  g.update('scan_staff', {
    set: { pin_tag: tag },
    where: { id, pin_tag: null, disabled_at: null },
  });

/** The person takes a new PIN at their next sign-in (taking it clears the flag). */
export const flagPinReset = (g: Grant, id: string) =>
  g.update('scan_staff', { set: { pin_reset_required: 1 }, where: { id } });

export interface OwnPinChange {
  pinHash: string;
  pinTag: string;
  macVersion: number;
  now: number;
  /** `first` while flagged; `repeat` is the one more draw inside the window, on the same sign-in. */
  issue: { kind: 'first'; binding: string } | { kind: 'repeat'; binding: string };
  audit: AuditEntry;
}

/**
 * The signed-in person's new PIN, set by the server. It moves with the epoch they were read at, so a
 * PIN an admin reset in between is not overwritten. The sign-in restarts here (a PIN set after a
 * sign-in began ends that sign-in on every other device), and the audit row is in the same batch.
 */
export async function setOwnPinGrant(
  ctx: ServiceContext,
  scanner: ScannerRow,
  staff: { id: string; authEpoch: number },
  change: OwnPinChange,
): Promise<void> {
  const { issue, now } = change;
  const first = issue.kind === 'first';
  const g = grant(ctx, {
    purpose: 'org_mode.scan.staff.pin_self',
    principal: {
      kind: 'scanner',
      scannerId: scanner.id,
      credentialEpoch: scannerEpochsOf(scanner).credential,
    },
    checks: [
      exactlyOne('scanners', { id: scanner.id, revoked_at: null }, undefined, 'config'),
      rowIs(
        'scan_staff',
        staff.id,
        {
          auth_epoch: staff.authEpoch,
          disabled_at: null,
          ...(first
            ? { pin_reset_required: 1 }
            : {
                pin_reset_required: 0,
                pin_issue_repeats: 0,
                pin_issued_binding: issue.binding,
              }),
        },
        'config',
      ),
    ],
    target: staff.id,
    codes: STAFF_CODES,
  });
  g.update('scan_staff', {
    set: {
      pin_hash: change.pinHash,
      pin_tag: change.pinTag,
      pin_mac_version: change.macVersion,
      pin_set_at: now,
      pin_reset_required: 0,
      ...(first
        ? { pin_issued_at: now, pin_issued_binding: issue.binding, pin_issue_repeats: 0 }
        : { pin_issue_repeats: 1 }),
      updated_at: maxNow(now),
    },
    where: { id: staff.id },
    require: 'one',
  });
  g.update('scanners', {
    set: { staff_since: now, staff_seen_at: now, updated_at: maxNow(now) },
    where: { id: scanner.id, staff_id: staff.id },
  });
  g.add(grantedAudit(g, ctx, change.audit));
  await g.commit();
}

/** Wrong PINs counted today against one person, and against the whole org (named sign-in and approval). */
export const namedDayKey = (staffId: string) => `scan:pinday:${staffId}`;
export const orgDayKey = (orgId: string) => `scan:pinday-org:${orgId}`;
export const deviceDayKey = (scannerId: string) => `scan:pinday-dev:${scannerId}`;

/** The person's and the device's wrong-named-PIN counters for the day, for the check that rides another batch. */
export const namedDayCountsStatement = (
  db: Db,
  staffId: string,
  scannerId: string,
  window: number,
) =>
  stmt(db, 'SELECT key, count FROM counters WHERE window_start = ? AND key IN (?, ?)', [
    window,
    namedDayKey(staffId),
    deviceDayKey(scannerId),
  ]);

/** An admin's PIN reset or Unlock: the person's wrong PINs of the day no longer count. */
export const clearNamedDayStatement = (db: Db, staffId: string) =>
  stmt(db, 'DELETE FROM counters WHERE key = ?', [namedDayKey(staffId)]);

/**
 * Pairing again keeps the scanner id, so it ends the device's wrong-PIN day lock. A part of the pairing
 * grant's own batch: it commits with a successful pairing and never on a refused one.
 */
export const clearDeviceDayPart = (scannerId: string): GrantPart =>
  writePart(
    'DELETE FROM counters WHERE key = ? AND {grant}',
    [deviceDayKey(scannerId)],
    RACE_DEVICE_DAY_CLEAR,
  );

/** A day's events for the admin digest, newest last. */
export const digestEvents = (db: Db, since: number, until: number) =>
  all<{
    org_id: string;
    action: string;
    at: number;
    actor_id: string;
    target_id: string;
    person: string | null;
    role: string | null;
    scanner: string | null;
  }>(
    db,
    `SELECT a.org_id, a.action, a.at, a.actor_id, a.target_id, st.name AS person, st.role AS role, sc.name AS scanner
     FROM audit_log a
     LEFT JOIN scan_staff st ON st.id = a.target_id AND a.target_type = 'scan_staff'
     LEFT JOIN scanners sc ON sc.id = a.actor_id AND a.actor_type = 'scanner'
     WHERE a.at >= ? AND a.at < ? AND a.org_id IS NOT NULL
       AND a.action IN ('scan_staff.pin_shared', 'scan_staff.pin_self_reset', 'scan.pin_named_org_cap')
     ORDER BY a.org_id, a.at`,
    [since, until],
  );
