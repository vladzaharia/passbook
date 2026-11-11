import type { Mode } from '../../../shared/contracts/common.ts';
import { grant } from '../../platform/authority.ts';
import { type Check, epochIs, exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { inList, maxNow } from '../../platform/authority-expr.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import { createDetachedContext, type ServiceContext } from '../../platform/service-context.ts';

type Db = D1Database;

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
  revokedAt: number | null;
  staffId: string | null;
  staffSince: number | null;
  staffSeenAt: number | null;
  updatedAt: number;
  /** Read with the credential columns in the same row: the epochs the actor is later checked against. */
  credentialEpoch?: number;
  configEpoch?: number;
  hasScreens?: boolean;
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
  csrf_secret, paired_at, expires_at, last_seen_at, revoked_at, staff_id, staff_since, staff_seen_at, updated_at,
  credential_epoch, config_epoch,
  EXISTS(SELECT 1 FROM scanners screen WHERE screen.org_id=scanners.org_id AND screen.mode=scanners.mode
    AND screen.device_role!='scan' AND screen.revoked_at IS NULL AND screen.token_hash IS NOT NULL) AS has_screens`;

/**
 * The epochs ride on the row without being enumerable: snapshots that serialize the row (sealed
 * proofs with strict schemas) keep their shape, and the guard reads them straight off this row.
 */
const toRow = (r: Raw): ScannerRow =>
  Object.defineProperties(toRowFields(r), {
    credentialEpoch: { value: r.credential_epoch, enumerable: false },
    configEpoch: { value: r.config_epoch, enumerable: false },
  });

const toRowFields = (r: Raw): ScannerRow => ({
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
  revokedAt: r.revoked_at,
  staffId: r.staff_id,
  staffSince: r.staff_since,
  staffSeenAt: r.staff_seen_at,
  updatedAt: r.updated_at,
  hasScreens: r.has_screens === 1,
});

export async function getScannerByPrefix(db: Db, prefix: string): Promise<ScannerRow | null> {
  const row = await first<Raw>(db, `SELECT ${COLUMNS} FROM scanners WHERE token_prefix = ?`, [
    prefix,
  ]);
  return row ? toRow(row) : null;
}

export async function getScanner(db: Db, id: string): Promise<ScannerRow | null> {
  const row = await first<Raw>(db, `SELECT ${COLUMNS} FROM scanners WHERE id = ?`, [id]);
  return row ? toRow(row) : null;
}

/** The presented credential is gone: revoked, expired, or a replaced token or CSRF secret. Epoch drift alone is not. */
export async function credentialGone(db: Db, scanner: ScannerRow, now: number): Promise<boolean> {
  const fresh = await getScanner(db, scanner.id);
  return (
    !fresh ||
    fresh.revokedAt !== null ||
    fresh.tokenHash !== scanner.tokenHash ||
    (scanner.csrfSecret !== null && fresh.csrfSecret !== scanner.csrfSecret) ||
    (fresh.expiresAt !== null && fresh.expiresAt <= now)
  );
}

/** Callers skip the call inside `everyMs` of the last touch; the WHERE keeps it safe against races. */
export async function touchScanner(
  db: Db,
  id: string,
  now: number,
  ipPrefix: string | null,
  everyMs: number,
): Promise<void> {
  await run(
    db,
    `UPDATE scanners SET last_seen_at = ?, last_ip_prefix = ?
     WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)`,
    [now, ipPrefix, id, now - everyMs],
  );
}

/** Why a bind or unbind was refused rather than applied; the codes keep the staff-sign-in contract. */
const STAFF_CODES = { config: 'SCAN_STAFF_CHANGED', lineage: 'SCAN_STAFF_CHANGED' } as const;

/** Every scanner row is read with its epochs; a row without them was built outside the guard. */
export const scannerEpochsOf = (scanner: ScannerRow) => {
  if (scanner.credentialEpoch === undefined || scanner.configEpoch === undefined)
    throw new AppError('SCAN_EPOCHS_MISSING', 500, 'Scanner epochs were not read with the row.');
  return { credential: scanner.credentialEpoch, config: scanner.configEpoch };
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
        device_role: 'scan',
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
    set: { staff_id: staff.id, staff_since: now, staff_seen_at: now, updated_at: maxNow(now) },
    where: { id: scanner.id },
    returning: ['id'],
  });
  try {
    await g.commit();
  } catch (error) {
    // Only a lost credential unpairs the device; a moved credential epoch is configuration drift.
    if (
      error instanceof AppError &&
      error.code === 'SCANNER_REPAIR' &&
      !(await credentialGone(ctx.env.DB, scanner, now))
    )
      throw new ConflictError('Configuration changed. Reload and retry.', 'SCAN_CONFIG_CHANGED');
    throw error;
  }
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
