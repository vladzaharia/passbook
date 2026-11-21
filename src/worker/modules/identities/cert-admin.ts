import type { z } from 'zod';
import type {
  IdentityCertificateDto,
  RevokeCertificateSchema,
} from '../../../shared/contracts/identities.ts';
import type { Actor } from '../../platform/context.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { ascClient } from './asc-client.ts';
import { getIdentityRow } from './repo.ts';
import {
  type CertificateRow,
  getCertificateRow,
  listCertificateRows,
  markCertificateRevoked,
} from './repo-certificates.ts';

const toDto = (r: CertificateRow): IdentityCertificateDto => ({
  id: r.id,
  state: r.state,
  origin: r.origin,
  certSha256: r.cert_sha256,
  notBefore: r.not_before,
  notAfter: r.not_after,
  createdAt: r.created_at,
  activatedAt: r.activated_at,
  endedAt: r.ended_at,
});

/** Newest first. */
export async function listIdentityCertificates(
  ctx: ServiceContext,
  identityId: string,
): Promise<{ items: IdentityCertificateDto[] }> {
  const rows = await listCertificateRows(ctx.env.DB, identityId);
  return { items: rows.reverse().map(toDto) };
}

/**
 * Revokes a certificate Apple issued for the identity and a newer one has replaced. Installed passes
 * signed with it stop validating, so the admin types the pass type ID to confirm.
 */
export async function revokeIdentityCertificate(
  ctx: ServiceContext,
  actor: Actor,
  identityId: string,
  input: z.infer<typeof RevokeCertificateSchema>,
): Promise<IdentityCertificateDto> {
  const identity = await getIdentityRow(ctx.env.DB, identityId);
  if (!identity) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  if (input.confirm !== identity.pass_type_identifier)
    throw new ValidationError(
      'The confirmation does not match the pass type ID.',
      [{ path: 'confirm', message: 'Type the pass type ID.' }],
      'IDENTITY_CONFIRM_MISMATCH',
    );
  const cert = await getCertificateRow(ctx.env.DB, input.certificateId);
  if (!cert || cert.identity_id !== identityId)
    throw new NotFoundError('Certificate not found.', 'IDENTITY_CERT_NOT_FOUND');
  if (cert.state !== 'superseded' || !cert.asc_certificate_id)
    throw new ConflictError(
      'Only a superseded certificate that Apple issued can be revoked.',
      'IDENTITY_CERT_NOT_REVOCABLE',
    );
  await ascClient(ctx.env as { APPLE?: unknown }).revokeCertificate(
    cert.asc_certificate_id,
    input.reason,
  );
  await markCertificateRevoked(ctx.env.DB, cert.id, ctx.clock.now());
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: identity.org_id,
    action: 'identity.certificate_revoke',
    targetType: 'identity',
    targetId: identityId,
    detail: { certificateId: cert.id, reason: input.reason, certSha256: cert.cert_sha256 },
  });
  const updated = await getCertificateRow(ctx.env.DB, cert.id);
  return toDto(updated ?? cert);
}
