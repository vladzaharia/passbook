import type { Mode } from '../../../shared/contracts/common.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { bump, prune } from '../../platform/counters.ts';
import { all, batch, chunk, first, placeholders, run, stmt } from '../../platform/db.ts';
import {
  type AppleCredential,
  appleCredentialParams,
  appleCredentialSql,
} from './repo-credential.ts';

export interface IdentityRef {
  id: string;
  nfcEnabled: boolean;
}

export async function identityByPassType(
  db: D1Database,
  passTypeId: string,
): Promise<IdentityRef | null> {
  const row = await first<{ id: string; nfc_enabled: number }>(
    db,
    'SELECT id, nfc_enabled FROM signing_identities WHERE pass_type_identifier = ?',
    [passTypeId],
  );
  return row ? { id: row.id, nfcEnabled: row.nfc_enabled === 1 } : null;
}

export async function registrationExists(
  db: D1Database,
  deviceId: string,
  pass: AppleCredential,
): Promise<boolean> {
  const row = await first<{ n: number }>(
    db,
    `SELECT 1 AS n FROM registrations r
     WHERE r.device_id = ? AND r.identity_id = ? AND r.pass_id = ?
       AND r.credential_generation = ?
       AND EXISTS (SELECT 1 FROM passes p WHERE ${appleCredentialSql})`,
    [deviceId, pass.identityId, pass.id, pass.credentialGeneration, ...appleCredentialParams(pass)],
  );
  return row !== null;
}

export async function registrationCount(db: D1Database, passId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM registrations r JOIN passes p ON p.id = r.pass_id
     WHERE r.pass_id = ? AND r.credential_generation = p.credential_generation
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending')`,
    [passId],
  );
  return row?.n ?? 0;
}

/**
 * Device and registration in one transaction; the `registrations_cap` trigger enforces the cap.
 * The push token is stored on the registration: one identity serves every org, so the device row
 * is shared and a token written there by one pass would redirect the others.
 */
export async function addRegistration(
  db: D1Database,
  r: { deviceId: string; pass: AppleCredential; pushToken: string; now: number },
): Promise<boolean> {
  const { pass } = r;
  const results = await batch(db, [
    stmt(
      db,
      `INSERT INTO devices (device_id, identity_id, push_token, updated_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM passes p WHERE ${appleCredentialSql})
       ON CONFLICT (device_id, identity_id) DO UPDATE SET updated_at = excluded.updated_at`,
      [r.deviceId, pass.identityId, r.pushToken, r.now, ...appleCredentialParams(pass)],
    ),
    stmt(
      db,
      `DELETE FROM registrations WHERE device_id = ? AND identity_id = ? AND pass_id = ?
       AND credential_generation != ?
       AND EXISTS (SELECT 1 FROM passes p WHERE ${appleCredentialSql})`,
      [
        r.deviceId,
        pass.identityId,
        pass.id,
        pass.credentialGeneration,
        ...appleCredentialParams(pass),
      ],
    ),
    stmt(
      db,
      `INSERT INTO registrations (device_id, identity_id, pass_id, push_token, created_at, credential_generation)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM passes p WHERE ${appleCredentialSql})`,
      [
        r.deviceId,
        pass.identityId,
        pass.id,
        r.pushToken,
        r.now,
        pass.credentialGeneration,
        ...appleCredentialParams(pass),
      ],
    ),
  ]);
  return (results[2]?.meta.changes ?? 0) > 0;
}

export async function updatePushToken(
  db: D1Database,
  r: { deviceId: string; pass: AppleCredential; pushToken: string },
): Promise<boolean> {
  const { pass } = r;
  const result = await run(
    db,
    `UPDATE registrations SET push_token = ?
     WHERE device_id = ? AND identity_id = ? AND pass_id = ? AND credential_generation = ?
       AND EXISTS (SELECT 1 FROM passes p WHERE ${appleCredentialSql})`,
    [
      r.pushToken,
      r.deviceId,
      pass.identityId,
      pass.id,
      pass.credentialGeneration,
      ...appleCredentialParams(pass),
    ],
  );
  return result.changes > 0;
}

export async function removeRegistration(
  db: D1Database,
  deviceId: string,
  pass: AppleCredential,
): Promise<'removed' | 'missing' | 'stale'> {
  const params = appleCredentialParams(pass);
  const results = await batch(db, [
    stmt(
      db,
      `DELETE FROM registrations
      WHERE device_id = ? AND identity_id = ? AND pass_id = ? AND credential_generation = ?
        AND EXISTS (SELECT 1 FROM passes p WHERE ${appleCredentialSql})`,
      [deviceId, pass.identityId, pass.id, pass.credentialGeneration, ...params],
    ),
    stmt(
      db,
      `DELETE FROM devices WHERE device_id = ? AND identity_id = ?
       AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.device_id = ? AND r.identity_id = ?)
       AND EXISTS (SELECT 1 FROM passes p WHERE ${appleCredentialSql})`,
      [deviceId, pass.identityId, deviceId, pass.identityId, ...params],
    ),
    stmt(db, `SELECT 1 FROM passes p WHERE ${appleCredentialSql}`, params),
  ]);
  if (!results[2]?.results.length) return 'stale';
  return (results[0]?.meta.changes ?? 0) > 0 ? 'removed' : 'missing';
}

export interface UpdatedSerial {
  serial: string;
  revision: number;
  passId: string;
  orgId: string;
  mode: Mode;
  version: number;
  credentialGeneration: number;
}

export async function serialsSince(
  db: D1Database,
  deviceId: string,
  identityId: string,
  since: number,
  limit: number,
): Promise<UpdatedSerial[]> {
  const rows = await all<{
    serial: string;
    revision: number;
    pass_id: string;
    org_id: string;
    mode: Mode;
    version: number;
    credential_generation: number;
  }>(
    db,
    `SELECT p.serial, p.revision, p.id AS pass_id, p.org_id, p.mode, p.version, p.credential_generation
     FROM registrations r JOIN passes p ON p.id = r.pass_id
       AND r.credential_generation = p.credential_generation
     JOIN orgs o ON o.id = p.org_id AND o.status = 'active'
     WHERE r.device_id = ? AND r.identity_id = ? AND p.identity_id = r.identity_id AND p.revision > ?
       AND p.test_data_quarantined = 0
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending')
     ORDER BY p.revision LIMIT ?`,
    [deviceId, identityId, since, limit],
  );
  return rows.map((r) => ({
    serial: r.serial,
    revision: r.revision,
    passId: r.pass_id,
    orgId: r.org_id,
    mode: r.mode,
    version: r.version,
    credentialGeneration: r.credential_generation,
  }));
}

/** Revalidate the captured page after asynchronous event recording, without adding newer rows. */
export async function currentSerials(
  db: D1Database,
  deviceId: string,
  identityId: string,
  captured: UpdatedSerial[],
): Promise<UpdatedSerial[]> {
  if (captured.length === 0) return [];
  const rows = await all<{ pass_id: string }>(
    db,
    `SELECT p.id AS pass_id FROM json_each(?) expected
     JOIN passes p ON p.id = json_extract(expected.value, '$.passId')
       AND p.serial = json_extract(expected.value, '$.serial')
       AND p.credential_generation = json_extract(expected.value, '$.credentialGeneration')
     JOIN registrations r ON r.pass_id = p.id AND r.identity_id = p.identity_id
       AND r.credential_generation = p.credential_generation
     JOIN orgs o ON o.id = p.org_id AND o.status = 'active'
     WHERE r.device_id = ? AND r.identity_id = ? AND p.test_data_quarantined = 0
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending')`,
    [JSON.stringify(captured), deviceId, identityId],
  );
  const current = new Set(rows.map((row) => row.pass_id));
  return captured.filter((row) => current.has(row.passId));
}

/** Passes of one identity with one of these serials, for attaching device log lines. */
export async function passesBySerials(
  db: D1Database,
  identityId: string,
  serials: string[],
): Promise<
  { id: string; orgId: string; mode: Mode; serial: string; credentialGeneration: number }[]
> {
  const out: {
    id: string;
    orgId: string;
    mode: Mode;
    serial: string;
    credentialGeneration: number;
  }[] = [];
  // identity id + serials stay under D1's 100 bound parameters.
  for (const part of chunk(serials, 99)) {
    const rows = await all<{
      id: string;
      org_id: string;
      mode: Mode;
      serial: string;
      credential_generation: number;
    }>(
      db,
      `SELECT p.id, p.org_id, p.mode, p.serial, p.credential_generation FROM passes p
       WHERE p.identity_id = ? AND p.serial IN (${placeholders(part.length)}) AND p.deleted_at IS NULL
         AND p.test_data_quarantined = 0
         AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
           WHERE t.pass_id = p.id AND t.state = 'pending')`,
      [identityId, ...part],
    );
    out.push(
      ...rows.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        mode: r.mode,
        serial: r.serial,
        credentialGeneration: r.credential_generation,
      })),
    );
  }
  return out;
}

/** True when one of these Wallet device ids is registered to the pass. */
export async function anyRegisteredDevice(
  db: D1Database,
  pass: Pick<AppleCredential, 'id' | 'serial' | 'credentialGeneration'>,
  deviceIds: string[],
): Promise<boolean> {
  const ids = deviceIds.slice(0, 20);
  if (ids.length === 0) return false;
  const row = await first(
    db,
    `SELECT 1 AS x FROM registrations r JOIN passes p ON p.id = r.pass_id
       AND r.credential_generation = p.credential_generation
     WHERE r.pass_id = ? AND p.serial = ? AND p.credential_generation = ?
       AND r.device_id IN (${placeholders(ids.length)}) AND p.test_data_quarantined = 0
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
         WHERE t.pass_id = p.id AND t.state = 'pending') LIMIT 1`,
    [pass.id, pass.serial, pass.credentialGeneration, ...ids],
  );
  return row !== null;
}

/** Adds `lines` to the hourly window and returns the new total. */
export const GLOBAL_LOG_KEY = 'apple.log';

export const bumpLogCounter = (db: D1Database, key: string, windowStart: number, lines: number) =>
  bump(db, key, windowStart, lines);

export async function insertLogs(
  db: D1Database,
  lines: string[],
  identityId: string | null,
  now: number,
): Promise<void> {
  await batch(
    db,
    lines.map((line) =>
      stmt(db, 'INSERT INTO wallet_logs (at, identity_id, line) VALUES (?, ?, ?)', [
        now,
        identityId,
        line,
      ]),
    ),
  );
}

export async function purgeLogs(db: D1Database, before: number): Promise<number> {
  const logs = await deleteInBatches(db, 'wallet_logs', 'at < ?', [before]);
  await prune(db, 'apple.log%', before);
  return logs;
}

export async function purgeRevisions(db: D1Database, before: number): Promise<number> {
  return deleteInBatches(db, 'revisions', 'at < ?', [before]);
}
