import type { SqlValue } from '../../platform/db.ts';
import type { CredentialTransferSource, TransferPass } from './repo-credential-transfer-read.ts';

// The captured source: the pass as read (`row_version`), its credential, lifecycle and link generations and
// holder, an active org and the signing identity revision. Content, personalization, assets, photos and the
// credential columns all move `row_version` (assets and photos through `image_generation`), so a branding
// save or a sync touch can no longer fail a holder reassign (authority-epochs.md F3).
export const sourceSql = `(
  (p.id = ? AND p.org_id = ? AND p.mode = ? AND p.row_version = ?
    AND p.credential_generation = ? AND p.lifecycle_generation = ? AND p.link_generation = ?)
  AND (p.holder_email IS ? AND p.owner_user_id IS ? AND p.test_data_quarantined = 0)
  AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = p.org_id AND o.status = 'active')
  AND EXISTS (SELECT 1 FROM signing_identities si WHERE si.id = p.identity_id
    AND (si.org_id IS NULL OR si.org_id = p.org_id) AND si.revision = ?)
)`;
export function sourceParams(s: TransferPass): SqlValue[] {
  const p = s.pass;
  return [
    p.id,
    p.orgId,
    p.mode,
    p.rowVersion,
    s.credentialGeneration,
    s.lifecycleGeneration,
    p.linkGeneration,
    p.holderEmail,
    p.ownerUserId,
    s.identityRevision,
  ];
}
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
