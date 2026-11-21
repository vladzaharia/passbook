import { all, batch, first, stmt } from '../../platform/db.ts';
import type { NewIdentity } from './repo.ts';

export interface CertificateRow {
  id: string;
  identity_id: string;
  credential_id: string | null;
  cert_sha256: string | null;
  not_before: number | null;
  not_after: number | null;
  asc_certificate_id: string | null;
  origin: 'upload' | 'asc' | 'csr' | 'env';
  state: 'pending' | 'active' | 'superseded' | 'revoked' | 'failed';
  created_at: number;
  activated_at: number | null;
  ended_at: number | null;
}

const COLUMNS = `id, identity_id, credential_id, cert_sha256, not_before, not_after, asc_certificate_id,
  origin, state, created_at, activated_at, ended_at`;

export function getCertificateRow(db: D1Database, id: string): Promise<CertificateRow | null> {
  return first<CertificateRow>(db, `SELECT ${COLUMNS} FROM identity_certificates WHERE id = ?`, [
    id,
  ]);
}

/** Oldest first. */
export function listCertificateRows(db: D1Database, identityId: string): Promise<CertificateRow[]> {
  return all<CertificateRow>(
    db,
    `SELECT ${COLUMNS} FROM identity_certificates WHERE identity_id = ? ORDER BY created_at, id`,
    [identityId],
  );
}

/** A pending row whose key credential carries this public-key hash (a retried begin finds its own key). */
export function findPendingByPubkey(
  db: D1Database,
  identityId: string,
  pubkeySha256: string,
): Promise<CertificateRow | null> {
  return first<CertificateRow>(
    db,
    `SELECT ic.id, ic.identity_id, ic.credential_id, ic.cert_sha256, ic.not_before, ic.not_after,
       ic.asc_certificate_id, ic.origin, ic.state, ic.created_at, ic.activated_at, ic.ended_at
     FROM identity_certificates ic
     JOIN credentials c ON c.id = ic.credential_id
     WHERE ic.identity_id = ? AND ic.state = 'pending' AND c.fingerprint = ?`,
    [identityId, pubkeySha256],
  );
}

export interface PendingCertificate {
  id: string;
  identityId: string;
  origin: CertificateRow['origin'];
  credential: NewIdentity['credential'];
  now: number;
}

/** The key credential (fingerprint = public-key hash) and its pending history row, together. */
export async function insertPendingCertificate(
  db: D1Database,
  p: PendingCertificate,
): Promise<void> {
  const c = p.credential;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at)
       VALUES (?, ?, 'pass_signer', ?, ?, ?, ?, ?, ?)`,
      [c.id, c.orgId, c.kekVersion, c.iv, c.wrappedDek, c.ciphertext, c.fingerprint, p.now],
    ),
    stmt(
      db,
      `INSERT INTO identity_certificates (id, identity_id, credential_id, origin, state, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [p.id, p.identityId, c.id, p.origin, p.now],
    ),
  ]);
}

export interface Activation {
  certId: string;
  identityId: string;
  pendingCredentialId: string;
  /** The credential the identity points at now; dropped with the swap. */
  oldCredentialId: string | null;
  certPem: string;
  certSha256: string;
  notBefore: number;
  notAfter: number;
  ascCertificateId: string | null;
  now: number;
}

/**
 * Pending to active in one batch: the old active row becomes superseded, the identity points at the
 * pending key and certificate, the old key goes. Every statement requires the row to still be
 * pending, so a concurrent activation changes nothing.
 */
export async function activateCertificate(db: D1Database, a: Activation): Promise<void> {
  const stillPending = `EXISTS (SELECT 1 FROM identity_certificates WHERE id = ?1 AND state = 'pending')`;
  await batch(db, [
    stmt(
      db,
      `UPDATE identity_certificates SET state = 'superseded', ended_at = ?2
       WHERE identity_id = ?3 AND state = 'active' AND ${stillPending}`,
      [a.certId, a.now, a.identityId],
    ),
    stmt(
      db,
      `UPDATE signing_identities
         SET credential_id = ?2, cert_pem = ?3, cert_sha256 = ?4, not_before = ?5, not_after = ?6, apns_health = 'unknown'
       WHERE id = ?7 AND ${stillPending}`,
      [
        a.certId,
        a.pendingCredentialId,
        a.certPem,
        a.certSha256,
        a.notBefore,
        a.notAfter,
        a.identityId,
      ],
    ),
    ...(a.oldCredentialId
      ? [
          stmt(db, `DELETE FROM credentials WHERE id = ?2 AND id != ?3 AND ${stillPending}`, [
            a.certId,
            a.oldCredentialId,
            a.pendingCredentialId,
          ]),
        ]
      : []),
    stmt(
      db,
      `UPDATE identity_certificates
         SET state = 'active', cert_sha256 = ?2, not_before = ?3, not_after = ?4, asc_certificate_id = ?5, activated_at = ?6
       WHERE id = ?1 AND state = 'pending'`,
      [a.certId, a.certSha256, a.notBefore, a.notAfter, a.ascCertificateId, a.now],
    ),
  ]);
}

/** Pending to failed; the unused key is deleted. */
export async function failPendingCertificate(
  db: D1Database,
  certId: string,
  now: number,
): Promise<void> {
  await batch(db, [
    stmt(
      db,
      `DELETE FROM credentials WHERE id = (SELECT credential_id FROM identity_certificates WHERE id = ? AND state = 'pending')`,
      [certId],
    ),
    stmt(
      db,
      `UPDATE identity_certificates SET state = 'failed', ended_at = ? WHERE id = ? AND state = 'pending'`,
      [now, certId],
    ),
  ]);
}
