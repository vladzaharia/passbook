import { derivedHmacKey } from '../../platform/crypto.ts';
import { toBase64Url } from '../../platform/ids.ts';
import type { AssetPassSnapshot } from './asset-types.ts';

/**
 * Bind the original request-local authority fields without retaining them in a grant plan. The
 * encoded input may contain credentials, so it exists only transiently for this keyed MAC and is
 * never cloned, passed to SQL as JSON, persisted, returned or logged.
 */
export function assetSnapshotInput(snapshot: AssetPassSnapshot): string {
  const pass = snapshot.pass;
  return JSON.stringify([
    pass.id,
    pass.orgId,
    pass.mode,
    pass.identityId,
    pass.serial,
    pass.templateId,
    pass.templateVersion,
    pass.releaseId,
    pass.version,
    pass.revision,
    pass.linkGeneration,
    pass.credentialGeneration,
    pass.lifecycleGeneration,
    pass.imageGeneration,
    pass.status,
    pass.removedAt,
    pass.deletedAt,
    pass.testDataQuarantined,
    pass.personalization,
    pass.fieldSources,
    pass.holderEmail,
    pass.ownerUserId,
    pass.downloadToken,
    pass.authToken,
    pass.objectKey,
    pass.objectSha256,
    pass.scanCode,
    pass.barcodeHash,
    pass.connectionId,
    pass.externalRef,
    snapshot.passJsonSnapshot,
    snapshot.identityPassTypeIdentifier,
    snapshot.identityTeamIdentifier,
    snapshot.identityRevision,
    snapshot.walletVersion,
    snapshot.walletTemplateVersion,
    snapshot.versionPersonalization,
    snapshot.transferPending,
    snapshot.orgRevision,
    snapshot.templateRevision,
    snapshot.connectionGeneration,
    snapshot.activeTemplateVersion,
    snapshot.displayTemplateVersion,
    snapshot.templateSnapshot?.raw ?? null,
    snapshot.activeReleaseId,
    snapshot.activeReleaseGeneration,
    snapshot.activeReleaseVersion,
    snapshot.activeReleaseCandidateHash,
    snapshot.assetPhoto,
    snapshot.passPersonalizationSnapshot,
    snapshot.fieldSourcesSnapshot,
    snapshot.credentialTombstoneRefs,
    snapshot.credentialKeysetCommitment,
  ]);
}

/** Never retain or expose the transient serialized HMAC input. */
export async function assetSnapshotProofFromInput(env: object, input: string): Promise<string> {
  const key = await derivedHmacKey(env, 'scan-asset-original-snapshot-v1');
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return toBase64Url(new Uint8Array(mac));
}
