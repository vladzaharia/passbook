import { all, first, run } from '../../platform/db.ts';
import type { SourceVersionRow } from './repo-account-source.ts';
import type { CredentialRow } from './repo-credentials.ts';

const COLUMNS =
  'id, scope, org_id, mode, provider, identity_hash, identity_hint, provenance, signer_ref, next_rotation_at, revision, current_version_id, verified_at, revoked_at, created_at, updated_at';

/** The platform's active Google credential of a mode: PassBook's service account and parent issuer. */
export function activePlatformGoogle(
  db: D1Database,
  mode: 'live' | 'test',
): Promise<CredentialRow | null> {
  return first<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE scope = 'platform' AND provider = 'google' AND mode = ? AND revoked_at IS NULL
       AND current_version_id IS NOT NULL`,
    [mode],
  );
}

/** The org's active Google credential of a mode. */
export function activeOrgGoogle(
  db: D1Database,
  orgId: string,
  mode: 'live' | 'test',
): Promise<CredentialRow | null> {
  return first<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE scope = 'org' AND org_id = ? AND provider = 'google' AND mode = ? AND revoked_at IS NULL`,
    [orgId, mode],
  );
}

/** Another org's active credential that already holds this issuer (identity hash). */
export async function issuerClaimedElsewhere(
  db: D1Database,
  identityHash: string,
  mode: 'live' | 'test',
  exceptOrgId: string,
): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM wallet_credentials
     WHERE provider = 'google' AND mode = ? AND identity_hash = ? AND revoked_at IS NULL
       AND (org_id IS NULL OR org_id != ?) LIMIT 1`,
    [mode, identityHash, exceptOrgId],
  );
  return row !== null;
}

/** Credentials whose key is the platform credential's, after `after`, oldest id first. */
export function signedBy(
  db: D1Database,
  signerId: string,
  after: string,
  limit: number,
): Promise<CredentialRow[]> {
  return all<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE signer_ref = ? AND revoked_at IS NULL AND current_version_id IS NOT NULL AND id > ?
     ORDER BY id LIMIT ?`,
    [signerId, after, limit],
  );
}

/** Active platform Google credentials whose rotation is due. */
export function dueKeyRotations(db: D1Database, now: number): Promise<CredentialRow[]> {
  return all<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE scope = 'platform' AND provider = 'google' AND revoked_at IS NULL
       AND next_rotation_at IS NOT NULL AND next_rotation_at <= ? ORDER BY next_rotation_at LIMIT 10`,
    [now],
  );
}

export function platformGoogleCredentials(db: D1Database): Promise<CredentialRow[]> {
  return all<CredentialRow>(
    db,
    `SELECT ${COLUMNS} FROM wallet_credentials
     WHERE scope = 'platform' AND provider = 'google' AND revoked_at IS NULL
       AND current_version_id IS NOT NULL ORDER BY id`,
  );
}

export interface SaKeyRow {
  key_name: string;
  credential_id: string;
  origin: 'created' | 'adopted';
  created_at: number;
  deleted_at: number | null;
}

/** Keys of one service account that PassBook created or adopted and has not deleted. */
export function liveKeysOf(db: D1Database, email: string): Promise<SaKeyRow[]> {
  return all<SaKeyRow>(
    db,
    `SELECT key_name, credential_id, origin, created_at, deleted_at FROM wallet_sa_keys
     WHERE deleted_at IS NULL AND instr(key_name, ?) > 0 ORDER BY created_at, key_name`,
    [`/serviceAccounts/${email}/keys/`],
  );
}

export async function recordKey(
  db: D1Database,
  key: { name: string; credentialId: string; origin: 'created' | 'adopted'; now: number },
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO wallet_sa_keys (key_name, credential_id, origin, created_at) VALUES (?, ?, ?, ?)`,
    [key.name, key.credentialId, key.origin, key.now],
  );
}

export async function markKeyDeleted(db: D1Database, name: string, now: number): Promise<void> {
  await run(
    db,
    'UPDATE wallet_sa_keys SET deleted_at = ? WHERE key_name = ? AND deleted_at IS NULL',
    [now, name],
  );
}

/** Parked rotation runs whose old key may now be deleted. */
export function cooledRotationRuns(db: D1Database, now: number): Promise<{ id: string }[]> {
  return all<{ id: string }>(
    db,
    `SELECT id FROM identity_runs
     WHERE provider = 'google' AND kind = 'rotate' AND state = 'waiting'
       AND waiting_for = 'old_key_cooldown'
       AND CAST(json_extract(external_ref, '$.deleteAfter') AS INTEGER) <= ?
     ORDER BY id LIMIT 25`,
    [now],
  );
}

/** Moves a parked run back to the queue. False when it is no longer waiting. */
export async function resumeRun(db: D1Database, id: string, now: number): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE identity_runs SET state = 'queued', waiting_for = NULL, updated_at = ?
     WHERE id = ? AND provider = 'google' AND state = 'waiting'`,
    [now, id],
  );
  return changes === 1;
}

/** A credential's version (the current one when `versionId` is null) with the parts needed to open it. */
export function versionRow(
  db: D1Database,
  credentialId: string,
  versionId: string | null,
): Promise<SourceVersionRow | null> {
  return first<SourceVersionRow>(
    db,
    `SELECT v.id AS version_id, v.credential_id, v.identity_hash AS version_identity, v.card_map,
       v.kek_version, v.iv, v.wrapped_dek, v.ciphertext, c.scope, c.org_id AS credential_org_id, c.mode,
       c.provider, c.identity_hash AS credential_identity, c.revoked_at
     FROM wallet_credentials c
     JOIN wallet_credential_versions v ON v.credential_id = c.id AND v.id = COALESCE(?, c.current_version_id)
     WHERE c.id = ?`,
    [versionId, credentialId],
  );
}
