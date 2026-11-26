import type { AppleRpc } from '../../../../workers/passbook-apple-connector/src/types.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditOnce, beginStep } from './provision-run.ts';
import { getCertificateRow, markCertificateRevoked } from './repo-certificates.ts';

/** The Apple call of a `revoke` run. A retry finds the certificate already revoked and calls nothing. */
export async function stepRevoke(ctx: ServiceContext, rpc: AppleRpc, runId: string): Promise<void> {
  const loaded = await beginStep(ctx, runId, 'revoke');
  const cert = loaded.ref.certId ? await getCertificateRow(ctx.env.DB, loaded.ref.certId) : null;
  if (!cert || cert.identity_id !== loaded.run.target_id)
    throw new NotFoundError('Certificate not found.', 'IDENTITY_CERT_NOT_FOUND');
  if (cert.state !== 'revoked') {
    if (cert.state !== 'superseded' || !cert.asc_certificate_id)
      throw new ConflictError(
        'Only a superseded certificate that Apple issued can be revoked.',
        'IDENTITY_CERT_NOT_REVOCABLE',
      );
    await rpc.revokeCertificate(cert.asc_certificate_id, 'compromised', runId);
    await markCertificateRevoked(ctx.env.DB, cert.id, ctx.clock.now());
  }
  await auditOnce(ctx, loaded, 'identity.certificate_revoked', {
    certificateId: cert.id,
    certSha256: cert.cert_sha256,
  });
}
