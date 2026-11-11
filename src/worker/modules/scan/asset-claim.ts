import { parseIsoDate } from '../../../passkit/schema/util.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { safeEqual, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import type { ScanActor } from './actor.ts';
import { assetActorScope } from './asset-authority.ts';
import type {
  AssetGrantPurpose,
  AssetGrantSource,
  AssetPassSnapshot,
  AssetWalletSnapshot,
} from './asset-types.ts';
import { walletIdentityMatches } from './wallet-snapshot.ts';

export function validRefs(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    value.every((ref) => typeof ref === 'string' && /^[a-f0-9]{64}$/.test(ref)) &&
    new Set(value).size === value.length
  );
}

/** Keep credentials and identifying scalars out of the serialized MAC input. */
async function sensitiveDigest(key: CryptoKey, value: string | null): Promise<string | null> {
  if (value === null) return null;
  const proof = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(proof));
}

function originalPassData(snapshot: AssetPassSnapshot): boolean {
  try {
    return (
      canonicalJson(JSON.parse(snapshot.passPersonalizationSnapshot)) ===
        canonicalJson(snapshot.pass.personalization) &&
      canonicalJson(JSON.parse(snapshot.fieldSourcesSnapshot)) ===
        canonicalJson(snapshot.pass.fieldSources)
    );
  } catch {
    return false;
  }
}

/** Derive only internal MAC input from the original evaluated snapshot. */
export async function grantData(
  ctx: ServiceContext,
  actor: ScanActor,
  snapshot: AssetPassSnapshot,
  connectionGeneration: number | null,
  activeVersion: string | null,
  refs: readonly string[],
  source: AssetGrantSource | undefined,
  requirePhoto: boolean,
  purpose: AssetGrantPurpose,
) {
  const { pass, assetPhoto } = snapshot;
  const now = ctx.clock.now();
  const wallet = activeWallet(snapshot, now);
  if (
    (purpose !== 'read' && purpose !== 'commit') ||
    (requirePhoto && purpose !== 'commit') ||
    snapshot.connectionGeneration !== connectionGeneration ||
    snapshot.activeTemplateVersion !== activeVersion ||
    pass.status !== 'active' ||
    pass.deletedAt !== null ||
    pass.removedAt !== null ||
    pass.testDataQuarantined ||
    snapshot.transferPending !== false ||
    !wallet ||
    !Number.isSafeInteger(pass.credentialGeneration) ||
    pass.credentialGeneration < 1 ||
    !Number.isSafeInteger(pass.lifecycleGeneration) ||
    pass.lifecycleGeneration < 0 ||
    !Number.isSafeInteger(pass.imageGeneration) ||
    pass.imageGeneration < 0 ||
    typeof snapshot.identityRevision !== 'number' ||
    !Number.isSafeInteger(snapshot.identityRevision) ||
    snapshot.identityRevision < 1 ||
    snapshot.orgRevision === null ||
    snapshot.templateRevision === null ||
    typeof snapshot.passPersonalizationSnapshot !== 'string' ||
    typeof snapshot.fieldSourcesSnapshot !== 'string' ||
    !originalPassData(snapshot) ||
    !validRefs(refs) ||
    typeof snapshot.credentialKeysetCommitment !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.credentialKeysetCommitment) ||
    !Object.hasOwn(snapshot, 'assetPhoto') ||
    (requirePhoto && !assetPhoto) ||
    (assetPhoto !== null &&
      (!assetPhoto ||
        typeof assetPhoto.version !== 'string' ||
        !assetPhoto.version ||
        typeof assetPhoto.key !== 'string' ||
        !assetPhoto.key ||
        typeof assetPhoto.sha1 !== 'string' ||
        !/^[a-f0-9]{40}$/.test(assetPhoto.sha1) ||
        (assetPhoto.includeInPass !== 0 && assetPhoto.includeInPass !== 1))) ||
    (source &&
      (!source.eventId || !source.sourceId || source.actor.scanner?.id !== source.sourceId))
  )
    return null;
  const noRelease =
    snapshot.activeReleaseId === null &&
    snapshot.activeReleaseGeneration === null &&
    snapshot.activeReleaseVersion === null &&
    snapshot.activeReleaseCandidateHash === null;
  if (noRelease) {
    if (
      pass.releaseId !== null ||
      snapshot.displayTemplateVersion !== pass.templateVersion ||
      activeVersion !== pass.templateVersion
    )
      return null;
  } else if (
    !snapshot.activeReleaseId ||
    !snapshot.activeReleaseVersion ||
    !snapshot.activeReleaseCandidateHash ||
    !/^[a-f0-9]{64}$/.test(snapshot.activeReleaseCandidateHash) ||
    typeof snapshot.activeReleaseGeneration !== 'number' ||
    !Number.isSafeInteger(snapshot.activeReleaseGeneration) ||
    snapshot.activeReleaseGeneration < 1 ||
    activeVersion !== snapshot.activeReleaseVersion ||
    (snapshot.displayTemplateVersion !== snapshot.activeReleaseVersion &&
      (purpose !== 'read' || snapshot.displayTemplateVersion !== null))
  )
    return null;
  // Capture every scalar and HMAC input before the first await; later mutation of the
  // caller's Candidate cannot change which authority the capability authenticates.
  const {
    id,
    orgId,
    mode,
    version,
    revision,
    linkGeneration,
    credentialGeneration,
    lifecycleGeneration,
    imageGeneration,
    identityId,
    status,
    removedAt,
    deletedAt,
    testDataQuarantined,
    objectSha256,
    barcodeHash,
    templateId,
    templateVersion,
    releaseId,
    connectionId,
  } = pass;
  const {
    credentialKeysetCommitment,
    transferPending,
    identityPassTypeIdentifier,
    identityTeamIdentifier,
    identityRevision,
    walletVersion,
    walletTemplateVersion,
    versionPersonalization,
    orgRevision,
    templateRevision,
    displayTemplateVersion,
    activeReleaseId,
    activeReleaseGeneration,
    activeReleaseVersion,
    activeReleaseCandidateHash,
  } = snapshot;
  const photoVersion = assetPhoto?.version ?? null;
  const photoSha1 = assetPhoto?.sha1 ?? null;
  const photoIncluded = assetPhoto?.includeInPass ?? null;
  const sourceId = source?.sourceId ?? null;
  const sourceEventId = source?.eventId ?? null;
  const sensitive = [
    canonicalJson(wallet),
    versionPersonalization,
    pass.serial,
    canonicalJson(pass.personalization),
    canonicalJson(pass.fieldSources),
    pass.holderEmail,
    pass.ownerUserId,
    pass.downloadToken,
    pass.authToken,
    pass.objectKey,
    pass.scanCode,
    pass.externalRef,
    assetPhoto?.key ?? null,
  ];
  const actorResults = Promise.all([
    assetActorScope(ctx, actor, pass),
    source ? assetActorScope(ctx, source.actor, pass) : Promise.resolve(null),
  ]).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const keyset = await credentialRefKeysetCommitment(ctx.env).catch(() => null);
  const actors = await actorResults;
  if (!keyset || !(await safeEqual(credentialKeysetCommitment, keyset))) return null;
  if ('error' in actors) throw actors.error;
  const [recipient, sender] = actors.value;
  if (!recipient || (source && !sender)) return null;
  const claimKey = await derivedHmacKey(ctx.env, 'scan-asset-claim');
  const [
    walletDigest,
    versionPersonalizationDigest,
    serialDigest,
    personalizationDigest,
    fieldSourcesDigest,
    holderEmailDigest,
    ownerUserDigest,
    downloadTokenDigest,
    authTokenDigest,
    objectKeyDigest,
    scanCodeDigest,
    externalRefDigest,
    photoKeyDigest,
  ] = await Promise.all(sensitive.map((value) => sensitiveDigest(claimKey, value)));
  return {
    recipientSession: recipient.session,
    sourceSession: sender?.session ?? null,
    fields: [
      'scan-asset-v3',
      recipient.fields,
      sourceId !== null ? [sourceId, sourceEventId, sender?.fields] : null,
      credentialKeysetCommitment,
      id,
      orgId,
      mode,
      version,
      revision,
      linkGeneration,
      credentialGeneration,
      lifecycleGeneration,
      imageGeneration,
      transferPending,
      serialDigest,
      identityId,
      identityPassTypeIdentifier,
      identityTeamIdentifier,
      identityRevision,
      walletVersion,
      walletDigest,
      versionPersonalization === null ? ['null'] : ['raw', versionPersonalizationDigest],
      walletTemplateVersion === null ? ['null'] : ['raw', walletTemplateVersion],
      status,
      removedAt,
      deletedAt,
      testDataQuarantined,
      personalizationDigest,
      fieldSourcesDigest,
      holderEmailDigest,
      ownerUserDigest,
      downloadTokenDigest,
      authTokenDigest,
      objectKeyDigest,
      objectSha256,
      scanCodeDigest,
      barcodeHash,
      externalRefDigest,
      templateId,
      templateVersion,
      releaseId,
      connectionId,
      connectionGeneration,
      orgRevision,
      templateRevision,
      activeVersion,
      displayTemplateVersion,
      activeReleaseId,
      activeReleaseGeneration,
      activeReleaseVersion,
      activeReleaseCandidateHash,
      photoVersion !== null ? [photoVersion, photoKeyDigest, photoSha1, photoIncluded] : null,
    ],
  };
}

/** A missing, malformed, voided or expired Wallet JSON never authorizes an image. */
export function activeWallet(
  snapshot: AssetWalletSnapshot,
  now: number,
): Record<string, unknown> | null {
  if (
    !snapshot.passJsonSnapshot ||
    typeof snapshot.identityRevision !== 'number' ||
    !Number.isSafeInteger(snapshot.identityRevision) ||
    snapshot.identityRevision < 1 ||
    typeof snapshot.walletVersion !== 'number' ||
    !Number.isSafeInteger(snapshot.walletVersion) ||
    snapshot.walletVersion < 1 ||
    snapshot.walletVersion > snapshot.pass.version ||
    (snapshot.versionPersonalization !== null &&
      typeof snapshot.versionPersonalization !== 'string') ||
    (snapshot.walletTemplateVersion !== null &&
      typeof snapshot.walletTemplateVersion !== 'string') ||
    !snapshot.pass.personalization ||
    typeof snapshot.pass.personalization !== 'object' ||
    Array.isArray(snapshot.pass.personalization)
  )
    return null;
  let value: unknown;
  try {
    value = JSON.parse(snapshot.passJsonSnapshot);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!walletIdentityMatches(snapshot, value)) return null;
  const wallet = value as { voided?: unknown; expirationDate?: unknown };
  if (wallet.voided !== undefined && typeof wallet.voided !== 'boolean') return null;
  if (wallet.expirationDate !== undefined && parseIsoDate(wallet.expirationDate) === undefined)
    return null;
  return validityOf(wallet, now).status === 'active' ? (value as Record<string, unknown>) : null;
}
