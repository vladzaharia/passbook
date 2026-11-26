import { all, batch, first, run, stmt } from '../../platform/db.ts';

export interface IdentityRow {
  id: string;
  org_id: string | null;
  label: string;
  pass_type_identifier: string;
  team_identifier: string;
  source: 'env' | 'db';
  env_prefix: string | null;
  credential_id: string | null;
  cert_pem: string | null;
  cert_sha256: string | null;
  not_before: number | null;
  not_after: number | null;
  apns_binding: string | null;
  apns_health: 'unknown' | 'healthy' | 'failing';
  nfc_enabled: number;
  is_default: number;
  issuing: number;
  provenance: 'platform' | 'managed' | 'own';
  rotation: 'auto' | 'csr' | 'manual';
  next_rotation_at: number | null;
  handle: string | null;
  /** Only `passes` identities sign for orgs; `device_test` is the platform's own. */
  purpose: 'passes' | 'device_test';
  created_at: number;
  revision: number;
}

export interface CredentialBlob {
  kek_version: number;
  iv: ArrayBuffer;
  wrapped_dek: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

const COLUMNS = `id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, credential_id,
  cert_pem, cert_sha256, not_before, not_after, apns_binding, apns_health, nfc_enabled, is_default, issuing, provenance, rotation, next_rotation_at, handle, purpose, created_at, revision`;

export function listIdentityRows(db: D1Database): Promise<IdentityRow[]> {
  return all<IdentityRow>(db, `SELECT ${COLUMNS} FROM signing_identities ORDER BY created_at, id`);
}

/** Oldest first, one page after the `after` id (the last row of the previous page). */
export function pageIdentityRows(
  db: D1Database,
  after: string | undefined,
  limit: number,
  orgId?: string,
  kind?: IdentityRow['provenance'],
  purpose?: IdentityRow['purpose'],
): Promise<IdentityRow[]> {
  const where = [
    ...(after
      ? ['(created_at, id) > (SELECT created_at, id FROM signing_identities WHERE id = ?)']
      : []),
    ...(orgId ? ['org_id = ?'] : []),
    ...(kind ? ['provenance = ?'] : []),
    ...(purpose ? ['purpose = ?'] : []),
  ];
  return all<IdentityRow>(
    db,
    `SELECT ${COLUMNS} FROM signing_identities
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at, id LIMIT ?`,
    [
      ...(after ? [after] : []),
      ...(orgId ? [orgId] : []),
      ...(kind ? [kind] : []),
      ...(purpose ? [purpose] : []),
      limit,
    ],
  );
}

export function identityRowStmt(db: D1Database, id: string) {
  return stmt(db, `SELECT ${COLUMNS} FROM signing_identities WHERE id = ?`, [id]);
}

export function getIdentityRow(db: D1Database, id: string): Promise<IdentityRow | null> {
  return identityRowStmt(db, id).first<IdentityRow>();
}

export function findByPassType(db: D1Database, passTypeIdentifier: string) {
  return first<{ id: string }>(
    db,
    'SELECT id FROM signing_identities WHERE pass_type_identifier = ?',
    [passTypeIdentifier],
  );
}

export function getDefaultRow(db: D1Database): Promise<IdentityRow | null> {
  return first<IdentityRow>(db, `SELECT ${COLUMNS} FROM signing_identities WHERE is_default = 1`);
}

export { orgDefaultIdentityId } from '../orgs/repo.ts';
export { ensurePlatformIdentity } from './repo-platform.ts';

export function getCredentialBlob(db: D1Database, id: string): Promise<CredentialBlob | null> {
  return first<CredentialBlob>(
    db,
    'SELECT kek_version, iv, wrapped_dek, ciphertext FROM credentials WHERE id = ?',
    [id],
  );
}

export interface NewIdentity {
  credential: {
    id: string;
    orgId: string | null;
    kekVersion: number;
    iv: Uint8Array;
    wrappedDek: Uint8Array;
    ciphertext: Uint8Array;
    fingerprint: string;
  };
  identity: {
    id: string;
    orgId: string | null;
    label: string;
    passTypeIdentifier: string;
    teamIdentifier: string;
    certPem: string;
    certSha256: string;
    notBefore: number;
    notAfter: number;
    nfcEnabled: boolean;
  };
  now: number;
}

/** Credential and identity rows are written together or not at all. */
export async function insertIdentity(db: D1Database, n: NewIdentity): Promise<void> {
  const c = n.credential;
  const i = n.identity;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at)
       VALUES (?, ?, 'pass_signer', ?, ?, ?, ?, ?, ?)`,
      [c.id, c.orgId, c.kekVersion, c.iv, c.wrappedDek, c.ciphertext, c.fingerprint, n.now],
    ),
    stmt(
      db,
      `INSERT INTO signing_identities
         (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, cert_pem, cert_sha256,
          not_before, not_after, nfc_enabled, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, 'db', ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        i.id,
        i.orgId,
        i.label,
        i.passTypeIdentifier,
        i.teamIdentifier,
        c.id,
        i.certPem,
        i.certSha256,
        i.notBefore,
        i.notAfter,
        i.nfcEnabled,
        n.now,
      ],
    ),
  ]);
}

export interface IdentityPatch {
  label: string;
  nfcEnabled: boolean;
  apnsBinding: string | null;
  isDefault: boolean;
  issuing: boolean;
  rotation: IdentityRow['rotation'];
}

export async function updateIdentityRow(
  db: D1Database,
  id: string,
  patch: IdentityPatch,
): Promise<void> {
  const update = stmt(
    db,
    `UPDATE signing_identities
     SET label = ?, nfc_enabled = ?, apns_binding = ?, is_default = ?, issuing = ?, rotation = ?
     WHERE id = ?`,
    [
      patch.label,
      patch.nfcEnabled,
      patch.apnsBinding,
      patch.isDefault,
      patch.issuing,
      patch.rotation,
      id,
    ],
  );
  // The partial unique index allows one default; clear the old one first.
  await batch(
    db,
    patch.isDefault
      ? [
          stmt(
            db,
            'UPDATE signing_identities SET is_default = 0 WHERE is_default = 1 AND id != ?',
            [id],
          ),
          update,
        ]
      : [update],
  );
}

export async function identityInUse(db: D1Database, id: string): Promise<boolean> {
  return (
    (await first(db, 'SELECT 1 AS x FROM passes WHERE identity_id = ? LIMIT 1', [id])) !== null
  );
}

export async function deleteIdentityRows(
  db: D1Database,
  id: string,
  credentialId: string | null,
  team: string,
): Promise<void> {
  await batch(db, [
    stmt(db, 'DELETE FROM signing_identities WHERE id = ?', [id]),
    // The team's push key goes with its last identity.
    stmt(
      db,
      `DELETE FROM apns_keys WHERE team_identifier = ?
       AND NOT EXISTS (SELECT 1 FROM signing_identities WHERE team_identifier = ?)`,
      [team, team],
    ),
    ...(credentialId ? [stmt(db, 'DELETE FROM credentials WHERE id = ?', [credentialId])] : []),
  ]);
}

export interface IdentityRotation {
  identityId: string;
  oldCredentialId: string | null;
  credential: NewIdentity['credential'];
  certPem: string;
  certSha256: string;
  notBefore: number;
  notAfter: number;
  now: number;
}

export interface IdentityFacts {
  checked_at: number | null;
  /** The probe's audit detail (JSON with health, status and reason). */
  detail: string | null;
  pass_count: number;
}

/** The last APNs check (audit log) and the signed pass count, capped like org counts. */
export async function identityFacts(db: D1Database, id: string): Promise<IdentityFacts> {
  const row = await first<IdentityFacts>(
    db,
    `SELECT
       (SELECT at FROM audit_log WHERE target_type = 'identity' AND target_id = ?1
          AND action = 'identity.apns_probe' ORDER BY at DESC, id DESC LIMIT 1) AS checked_at,
       (SELECT detail FROM audit_log WHERE target_type = 'identity' AND target_id = ?1
          AND action = 'identity.apns_probe' ORDER BY at DESC, id DESC LIMIT 1) AS detail,
       (SELECT count(*) FROM (SELECT 1 FROM passes WHERE identity_id = ?1 LIMIT 100000)) AS pass_count`,
    [id],
  );
  return row ?? { checked_at: null, detail: null, pass_count: 0 };
}

export async function setProbeHealth(
  db: D1Database,
  id: string,
  health: 'healthy' | 'failing',
): Promise<void> {
  await run(db, 'UPDATE signing_identities SET apns_health = ? WHERE id = ?', [health, id]);
}

/** Swaps cert and key atomically: new credential, repoint, drop the old credential. */
export async function rotateIdentityRows(db: D1Database, r: IdentityRotation): Promise<void> {
  const c = r.credential;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at, rotated_at)
       VALUES (?, ?, 'pass_signer', ?, ?, ?, ?, ?, ?, ?)`,
      [c.id, c.orgId, c.kekVersion, c.iv, c.wrappedDek, c.ciphertext, c.fingerprint, r.now, r.now],
    ),
    stmt(
      db,
      `UPDATE signing_identities
         SET credential_id = ?, cert_pem = ?, cert_sha256 = ?, not_before = ?, not_after = ?, apns_health = 'unknown'
       WHERE id = ?`,
      [c.id, r.certPem, r.certSha256, r.notBefore, r.notAfter, r.identityId],
    ),
    ...(r.oldCredentialId
      ? [stmt(db, 'DELETE FROM credentials WHERE id = ?', [r.oldCredentialId])]
      : []),
  ]);
}

/** Passes per identity, for a page of identities in one query. */
export async function passCounts(
  db: D1Database,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await all<{ identity_id: string; n: number }>(
    db,
    `SELECT identity_id, count(*) AS n FROM passes
     WHERE identity_id IN (${ids.map(() => '?').join(', ')}) GROUP BY identity_id`,
    ids,
  );
  return new Map(rows.map((r) => [r.identity_id, r.n]));
}
