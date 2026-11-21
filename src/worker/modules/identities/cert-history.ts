import { ConflictError, NotFoundError, UpstreamError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { CertDetails } from './cert.ts';
import { buildIdentityMaterial } from './certificates.ts';
import { certPubkeySha256, generateCsr } from './csr.ts';
import { clearIdentityKeyCache } from './db-resolver.ts';
import { intermediatePem } from './env-identity.ts';
import { openPendingKey, sealPendingKey } from './pending-key.ts';
import type { IdentityRow } from './repo.ts';
import {
  activateCertificate,
  type CertificateRow,
  failPendingCertificate,
  findPendingByPubkey,
  getCertificateRow,
  insertPendingCertificate,
} from './repo-certificates.ts';

export interface PendingCsr {
  certId: string;
  /** Send to Apple as base64. */
  csrDer: Uint8Array;
  pubkeySha256: string;
}

export type ActivatedCertificate = Pick<CertDetails, 'sha256' | 'notBefore' | 'notAfter'>;

/** The certificate in a provisioner listing whose public key is `pubkeySha256`, if an earlier attempt got one issued. */
export async function adoptByPubkey<
  T extends { der: Uint8Array | null; expiresAt?: number | null },
>(
  certificates: readonly T[],
  pubkeySha256: string,
  log?: ServiceContext['log'],
): Promise<T | null> {
  // A listing entry without its certificate might be ours: ordering again would orphan one more.
  if (certificates.some((c) => !c.der))
    throw new UpstreamError(
      'Apple listed a certificate without its content.',
      'ASC_CERT_DER_MISSING',
    );
  const matches: T[] = [];
  for (const candidate of certificates)
    if (candidate.der && (await certPubkeySha256(candidate.der)) === pubkeySha256)
      matches.push(candidate);
  if (matches.length > 1)
    log?.warn('identity.cert_duplicate', {
      count: matches.length,
      code: 'IDENTITY_CERT_DUPLICATE',
    });
  return matches.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0] ?? null;
}

/** New key and CSR for an identity, with the key sealed as a pending credential and a pending history row. */
export async function beginPendingCertificate(
  ctx: ServiceContext,
  row: IdentityRow,
  origin: CertificateRow['origin'] = 'asc',
): Promise<PendingCsr> {
  const csr = await generateCsr(row.pass_type_identifier);
  const certId = ctx.ids.id();
  await insertPendingCertificate(ctx.env.DB, {
    id: certId,
    identityId: row.id,
    origin,
    credential: await sealPendingKey(ctx.env, {
      id: ctx.ids.id(),
      orgId: row.org_id,
      privateKeyPem: csr.privateKeyPem,
      pubkeySha256: csr.pubkeySha256,
    }),
    now: ctx.clock.now(),
  });
  ctx.log.info('identity.cert_pending', { identityId: row.id, certId });
  return { certId, csrDer: csr.csrDer, pubkeySha256: csr.pubkeySha256 };
}

/** The pending row for a key hash, so a retried step reuses it instead of starting another. */
export function findPendingCertificate(
  ctx: ServiceContext,
  identityId: string,
  pubkeySha256: string,
): Promise<CertificateRow | null> {
  return findPendingByPubkey(ctx.env.DB, identityId, pubkeySha256);
}

/**
 * Validates Apple's certificate against the pending key and makes it the identity's active one.
 * Safe to repeat: a row already active with the same certificate returns its details unchanged.
 */
export async function activatePendingCertificate(
  ctx: ServiceContext,
  row: IdentityRow,
  certId: string,
  issued: { certificateDer: Uint8Array; ascCertificateId: string | null },
): Promise<ActivatedCertificate> {
  const now = ctx.clock.now();
  const pending = await getCertificateRow(ctx.env.DB, certId);
  if (!pending || pending.identity_id !== row.id)
    throw new NotFoundError('No pending certificate for this identity.', 'CERT_PENDING_NOT_FOUND');
  const sha256 = await sha256Hex(issued.certificateDer);
  if (pending.state === 'active' && pending.cert_sha256 === sha256)
    return { sha256, notBefore: pending.not_before ?? 0, notAfter: pending.not_after ?? 0 };
  if (pending.state !== 'pending' || !pending.credential_id)
    throw new ConflictError('This certificate is no longer pending.', 'CERT_NOT_PENDING');

  const checked = await buildIdentityMaterial({
    certificateDer: issued.certificateDer,
    privateKeyPem: await openPendingKey(ctx.env, pending.credential_id, row.org_id),
    passTypeIdentifier: row.pass_type_identifier,
    teamIdentifier: row.team_identifier,
    intermediatePem: intermediatePem(ctx.env),
    now,
  });
  const swapped = await activateCertificate(ctx.env.DB, {
    certId,
    identityId: row.id,
    pendingCredentialId: pending.credential_id,
    expectedRevision: row.revision,
    expectedCredentialId: row.credential_id,
    certPem: checked.certificatePem,
    certSha256: checked.details.sha256,
    notBefore: checked.details.notBefore,
    notAfter: checked.details.notAfter,
    ascCertificateId: issued.ascCertificateId,
    now,
  });
  if (!swapped)
    throw new ConflictError(
      'The identity changed while its certificate was being activated.',
      'IDENTITY_CHANGED',
    );
  clearIdentityKeyCache();
  ctx.log.info('identity.cert_activated', { identityId: row.id, certId });
  const { details } = checked;
  return { sha256: details.sha256, notBefore: details.notBefore, notAfter: details.notAfter };
}

/** A failed run's leftovers: the row becomes `failed` and its unused key is deleted. */
export async function abandonPendingCertificate(
  ctx: ServiceContext,
  certId: string,
): Promise<void> {
  await failPendingCertificate(ctx.env.DB, certId, ctx.clock.now());
  ctx.log.info('identity.cert_abandoned', { certId });
}
