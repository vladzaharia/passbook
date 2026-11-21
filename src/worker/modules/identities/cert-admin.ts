import type { z } from 'zod';
import type {
  IdentityCertificateDto,
  IdentityRunDto,
  RevokeCertificateSchema,
} from '../../../shared/contracts/identities.ts';
import type { Actor } from '../../platform/context.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { getIdentityRow } from './repo.ts';
import {
  type CertificateRow,
  getCertificateRow,
  listCertificateRows,
} from './repo-certificates.ts';
import { reissueDrained } from './repo-provision.ts';
import { startRevocation } from './run-start.ts';
import { requireRun, toRunDto } from './runs-service.ts';

/** A superseded certificate may be revoked after this long even if no reissue was run (design 5.1). */
export const REVOKE_WAIT_MS = 72 * 3_600_000;

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
 * Starts the revocation of a certificate Apple issued for the identity and a newer one has replaced.
 * Installed passes signed with it stop validating, so: the admin types the pass type ID, platform
 * identities are never touched, and it waits until the reissue has drained or 72 hours have passed.
 * Apple is called by the `revoke` run, never from here.
 */
export async function requestCertificateRevoke(
  ctx: ServiceContext,
  actor: Actor,
  identityId: string,
  input: z.infer<typeof RevokeCertificateSchema>,
): Promise<IdentityRunDto> {
  const identity = await getIdentityRow(ctx.env.DB, identityId);
  if (!identity) throw new NotFoundError('Signing identity not found.', 'IDENTITY_NOT_FOUND');
  if (identity.provenance === 'platform' || identity.org_id === null)
    throw new ConflictError(
      'The platform identity cannot have a certificate revoked.',
      'IDENTITY_PROTECTED',
    );
  if (input.confirm !== identity.pass_type_identifier)
    throw new ValidationError(
      'The confirmation does not match the pass type ID.',
      [{ path: 'confirm', message: 'Type the pass type ID.' }],
      'IDENTITY_CONFIRM_MISMATCH',
    );
  const cert = await getCertificateRow(ctx.env.DB, input.certificateId);
  if (!cert || cert.identity_id !== identityId)
    throw new NotFoundError('Certificate not found.', 'IDENTITY_CERT_NOT_FOUND');
  if (cert.state !== 'superseded' || cert.origin !== 'asc' || !cert.asc_certificate_id)
    throw new ConflictError(
      'Only a superseded certificate that Apple issued can be revoked.',
      'IDENTITY_CERT_NOT_REVOCABLE',
    );
  const endedAt = cert.ended_at ?? cert.created_at;
  if (
    ctx.clock.now() - endedAt < REVOKE_WAIT_MS &&
    !(await reissueDrained(ctx.env.DB, identityId, endedAt))
  )
    throw new ConflictError(
      'Reissue the identity passes first, or wait 72 hours after the renewal.',
      'IDENTITY_REISSUE_PENDING',
    );
  const started = await startRevocation(ctx, {
    identityId,
    orgId: identity.org_id,
    certId: cert.id,
    createdBy: actor.type === 'user' ? actor.id : null,
  });
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: identity.org_id,
    action: 'identity.certificate_revoke_requested',
    targetType: 'identity',
    targetId: identityId,
    detail: { certificateId: cert.id, runId: started.runId },
  });
  return toRunDto(await requireRun(ctx, started.runId));
}
