import type { Mode } from '../../../shared/contracts/common.ts';
import { grant } from '../../platform/authority.ts';
import { type Check, epochIs, exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { inList, maxNow } from '../../platform/authority-expr.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { createDetachedContext, type ServiceContext } from '../../platform/service-context.ts';
import { RACE_STAFF_BIND, RACE_STAFF_UNBIND } from './race-tags.ts';

type Db = D1Database;

const EPOCHS: unique symbol = Symbol('scanner.epochs');
type Epochs = { credential: number; config: number };

/** The device side of a `scanners` row. Console CRUD SQL lives in repo-scanners.ts (stream SC). */
export interface ScannerRow {
  id: string;
  orgId: string;
  mode: Mode;
  kind: 'device' | 'terminal' | 'display';
  deviceRole: 'scan' | 'customer' | 'monitor';
  name: string;
  eventId: string | null;
  settings: string;
  timeZone: string;
  tokenPrefix: string | null;
  tokenHash: string | null;
  csrfSecret: string | null;
  pairedAt: number | null;
  expiresAt: number | null;
  lastSeenAt: number | null;
  /** The last request that was not an upload (`POST /batch`, `POST /device`), stamped by the server: the floor for a queued read. */
  contactAt: number | null;
  /** The contact before the last silence of `CONTACT_GAP_MS`, and when the contact after it came: see `graceFloor`. */
  contactPrevAt: number | null;
  onlineSince: number | null;
  revokedAt: number | null;
  staffId: string | null;
  staffSince: number | null;
  staffSeenAt: number | null;
  updatedAt: number;
  hasScreens?: boolean;
  [EPOCHS]?: Epochs;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  kind: 'device' | 'terminal' | 'display';
  device_role: 'scan' | 'customer' | 'monitor';
  name: string;
  event_id: string | null;
  settings: string;
  time_zone: string;
  token_prefix: string | null;
  token_hash: string | null;
  csrf_secret: string | null;
  paired_at: number | null;
  expires_at: number | null;
  last_seen_at: number | null;
  contact_at: number | null;
  contact_prev_at: number | null;
  online_since: number | null;
  revoked_at: number | null;
  staff_id: string | null;
  staff_since: number | null;
  staff_seen_at: number | null;
  updated_at: number;
  credential_epoch: number;
  config_epoch: number;
  has_screens: number;
}

const COLUMNS = `id, org_id, mode, kind, device_role, name, event_id, settings, time_zone, token_prefix, token_hash,
  csrf_secret, paired_at, expires_at, last_seen_at, contact_at, contact_prev_at, online_since, revoked_at, staff_id, staff_since, staff_seen_at, updated_at,
  credential_epoch, config_epoch,
  EXISTS(SELECT 1 FROM scanners screen WHERE screen.org_id=scanners.org_id AND screen.mode=scanners.mode
    AND screen.device_role!='scan' AND screen.revoked_at IS NULL AND screen.token_hash IS NOT NULL) AS has_screens`;

/**
 * Read with the credential columns in the same row, they are the epochs the actor is later checked
 * against. They hang off the row under a symbol key, like `scan-epochs.ts`: a spread keeps them,
 * `JSON.stringify` and strict zod schemas ignore them.
 */
const toRow = (r: Raw): ScannerRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  kind: r.kind,
  deviceRole: r.device_role,
  name: r.name,
  eventId: r.event_id,
  settings: r.settings,
  timeZone: r.time_zone,
  tokenPrefix: r.token_prefix,
  tokenHash: r.token_hash,
  csrfSecret: r.csrf_secret,
  pairedAt: r.paired_at,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  contactAt: r.contact_at,
  contactPrevAt: r.contact_prev_at,
  onlineSince: r.online_since,
  revokedAt: r.revoked_at,
  staffId: r.staff_id,
  staffSince: r.staff_since,
  staffSeenAt: r.staff_seen_at,
  updatedAt: r.updated_at,
  hasScreens: r.has_screens === 1,
  [EPOCHS]: { credential: r.credential_epoch, config: r.config_epoch },
});

export async function getScannerByPrefix(db: Db, prefix: string): Promise<ScannerRow | null> {
  const row = await first<Raw>(db, `SELECT ${COLUMNS} FROM scanners WHERE token_prefix = ?`, [
    prefix,
  ]);
  return row ? toRow(row) : null;
}

export const scannerHasTemplates = async (db: Db, scannerId: string) =>
  !!(await first<{ present: number }>(
    db,
    'SELECT 1 AS present FROM scanner_templates WHERE scanner_id=? LIMIT 1',
    [scannerId],
  ));

export async function getScanner(db: Db, id: string): Promise<ScannerRow | null> {
  const row = await first<Raw>(db, `SELECT ${COLUMNS} FROM scanners WHERE id = ?`, [id]);
  return row ? toRow(row) : null;
}

/** Callers skip the call inside `everyMs` of the last touch; the WHERE keeps it safe against races. */
/** A device that makes no request for this long needs pairing again; each request slides the window. */
export const DEVICE_IDLE_MS = 90 * 86_400_000;
/** The expiry a device is paired with. It is a default, not a limit: activity keeps the device paired. */
export const DEVICE_MAX_MS = 180 * 86_400_000;

export async function touchScanner(
  db: Db,
  id: string,
  now: number,
  ipPrefix: string | null,
  everyMs: number,
  /** False for an upload: it stamps the device as seen but never moves `contact_at`. */
  contact = true,
): Promise<void> {
  // A contact after a real silence of CONTACT_GAP_MS keeps the contact before it (a row from before 0175 has only
  // `last_seen_at`) and starts a new stretch. The stored contact lags the real one by up to `everyMs`, so a stored
  // age of GAP + everyMs is the least that proves a real silence of GAP. While a grace is open neither column moves
  // (a second gap must not re-date the first outage, nor chain graces). No commas: a stamp-only write is matched
  // by tools/authority-scope.ts.
  const gap =
    '? = 1 AND (contact_at <= ? OR contact_at IS NULL AND last_seen_at <= ?) AND (online_since IS NULL OR online_since <= ?)';
  const c = contact ? 1 : 0;
  const silent = [
    c,
    now - CONTACT_GAP_MS - everyMs,
    now - CONTACT_GAP_MS - everyMs,
    now - CONTACT_GRACE_MS,
  ];
  await run(
    db,
    `UPDATE scanners SET last_seen_at = ?, last_ip_prefix = ?,
       contact_prev_at = CASE WHEN ${gap} THEN CASE WHEN contact_at IS NULL THEN last_seen_at ELSE contact_at END ELSE contact_prev_at END,
       online_since = CASE WHEN ${gap} THEN ? ELSE online_since END,
       contact_at = CASE WHEN ? = 1 THEN ? ELSE contact_at END
     WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?
       OR (? = 1 AND (contact_at IS NULL OR contact_at <= ?)))`,
    [now, ipPrefix, ...silent, ...silent, now, c, now, id, now - everyMs, c, now - everyMs],
  );
}

/**
 * The reconnect grace behind the floor for a queued read. A request after a silence of `CONTACT_GAP_MS` or
 * more keeps the contact before it; for `CONTACT_GRACE_MS` after that request every batch is judged against
 * the pre-gap contact, not the reconnect, so the order of polls, sign-in, a refused sync and upload chunks
 * does not matter to an honest door. Bound for a dishonest door: the floor is never earlier than the last
 * contact the server saw before a real silence of at least `CONTACT_GAP_MS`, and the grace is spent within
 * `CONTACT_GRACE_MS` of the reconnect; a door that stays silent that long gets the same floor. The most the
 * grace adds is that the door was in contact for up to `CONTACT_GRACE_MS` of the span it back-dates over.
 * A row with no `contact_at` yet (before 0175 reached it) falls back to `last_seen_at`.
 */
export const CONTACT_GAP_MS = 3 * 60_000;
export const CONTACT_GRACE_MS = 20 * 60_000;

export function contactFloorOf(
  scanner: Pick<ScannerRow, 'contactAt' | 'contactPrevAt' | 'onlineSince' | 'lastSeenAt'>,
  now: number,
): number {
  const current = scanner.contactAt ?? scanner.lastSeenAt ?? 0;
  return scanner.contactPrevAt !== null &&
    scanner.onlineSince !== null &&
    now - scanner.onlineSince < CONTACT_GRACE_MS
    ? Math.min(current, scanner.contactPrevAt)
    : current;
}

/** Why a bind or unbind was refused rather than applied; the codes keep the staff-sign-in contract. */
const STAFF_CODES = { config: 'SCAN_STAFF_CHANGED', lineage: 'SCAN_STAFF_CHANGED' } as const;

/** Every scanner row is read with its epochs; a row without them was built outside the guard. */
export const scannerEpochsOf = (scanner: ScannerRow): Epochs => {
  const epochs = scanner[EPOCHS];
  if (!epochs)
    throw new AppError('SCAN_EPOCHS_MISSING', 500, 'Scanner epochs were not read with the row.');
  return epochs;
};

export const credentialEpochOf = (scanner: ScannerRow): number =>
  scannerEpochsOf(scanner).credential;

/** No device row: the scanner is not part of a scanning session (a legacy standalone). */
const unsessioned = (scannerId: string): Check =>
  tenantCheck(
    'config',
    'NOT EXISTS (SELECT 1 FROM scanning_devices d WHERE d.scanner_id = ? AND d.org_id = {org} AND d.mode = {mode})',
    [scannerId],
  );

/**
 * Bind while the credential, the scanner configuration, the verified staff PIN and the scanning
 * session are the ones the sign-in was derived from. Anything else is a classified refusal.
 */
export async function bindStaff(
  ctx: ServiceContext,
  scanner: ScannerRow,
  staff: { id: string; authEpoch: number },
  session?: { id: string; configEpoch: number },
): Promise<void> {
  const epochs = scannerEpochsOf(scanner);
  const now = ctx.clock.now();
  const checks: Check[] = [
    epochIs('scanners', scanner.id, 'config_epoch', epochs.config),
    exactlyOne(
      'scanners',
      {
        id: scanner.id,
        // A monitor signs a person in only with Desk actions on (staff-session.ts).
        device_role: inList(['scan', 'monitor']),
        kind: inList(['device', 'display']),
        revoked_at: null,
      },
      undefined,
      'config',
    ),
    rowIs('scan_staff', staff.id, { auth_epoch: staff.authEpoch, disabled_at: null }, 'config'),
    ...(session
      ? [
          rowIs(
            'scanning_sessions',
            session.id,
            { config_epoch: session.configEpoch, status: 'active' },
            'config',
          ),
          exactlyOne('scanning_devices', { scanner_id: scanner.id, session_id: session.id }),
        ]
      : [unsessioned(scanner.id)]),
  ];
  const g = grant(ctx, {
    purpose: 'org_mode.scan.staff.bind',
    principal: { kind: 'scanner', scannerId: scanner.id, credentialEpoch: epochs.credential },
    checks,
    target: staff.id,
    codes: STAFF_CODES,
  });
  g.update('scanners', {
    tag: RACE_STAFF_BIND,
    set: { staff_id: staff.id, staff_since: now, staff_seen_at: now, updated_at: maxNow(now) },
    where: { id: scanner.id },
    returning: ['id'],
  });
  // A refusal as `actor` is classified by the caller (`scannerRefusal`): only a lost credential unpairs.
  await g.commit();
}

/**
 * Clear the observed binding. A scanner whose credential moved on, or whose binding is already
 * gone, is left alone: ending a binding only ever reduces access. Callers hold a context; the
 * database form serves the guard and fixtures.
 */
export async function unbindStaff(target: Db | ServiceContext, scanner: ScannerRow): Promise<void> {
  const ctx = 'env' in target ? target : createDetachedContext({ DB: target } as AppEnv);
  if (scanner.staffId === null) return;
  const epochs = scannerEpochsOf(scanner);
  const g = grant(ctx, {
    purpose: 'org_mode.scan.staff.unbind',
    principal: { kind: 'scanner', scannerId: scanner.id, credentialEpoch: epochs.credential },
    target: scanner.id,
  });
  g.update('scanners', {
    tag: RACE_STAFF_UNBIND,
    set: { staff_id: null, staff_since: null, staff_seen_at: null },
    inc: ['updated_at'],
    where: { id: scanner.id, staff_id: scanner.staffId, staff_since: scanner.staffSince },
    returning: ['id'],
  });
  let results: D1Result[];
  try {
    results = await g.commit();
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    ctx.log.info('scan.staff_unbind_refused', { scannerId: scanner.id, code: error.code });
    return;
  }
  if (results.at(-1)?.results.length === 1) {
    scanner.updatedAt += 1;
    scanner.staffId = null;
    scanner.staffSince = null;
    scanner.staffSeenAt = null;
  }
}

export async function touchStaff(
  db: Db,
  scanner: ScannerRow,
  now: number,
  everyMs: number,
): Promise<void> {
  await run(
    db,
    `UPDATE scanners SET staff_seen_at = ?
     WHERE id = ? AND token_hash IS ? AND staff_id IS ? AND staff_since IS ?
       AND staff_id IS NOT NULL AND staff_seen_at <= ?`,
    [now, scanner.id, scanner.tokenHash, scanner.staffId, scanner.staffSince, now - everyMs],
  );
}
