import type { CredentialTransferSource, TransferPass } from './repo-credential-transfer-read.ts';

export function matchesCredentialSource(s: TransferPass, e: CredentialTransferSource): boolean {
  const p = s.pass;
  return (
    e.orgId === p.orgId &&
    e.mode === p.mode &&
    e.holderEmail === p.holderEmail &&
    e.ownerUserId === p.ownerUserId &&
    e.rowVersion === p.rowVersion &&
    e.credentialGeneration === s.credentialGeneration &&
    e.lifecycleGeneration === s.lifecycleGeneration &&
    e.releaseId === p.releaseId &&
    e.downloadToken === p.downloadToken &&
    e.linkGeneration === p.linkGeneration
  );
}
