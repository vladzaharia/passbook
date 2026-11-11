import { CheckInPolicySchema } from '../../../shared/contracts/check-in.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { fromBase64Url, toBase64Url } from '../../platform/ids.ts';
import { canonicalAuthority, MAX_D1_ROW_BYTES } from './live-canonical-authority.ts';
import { validCredentialTombstoneRefs } from './repo-credential-tombstones.ts';
import type { Candidate } from './repo-lookup.ts';
import { walletIdentityMatches } from './wallet-snapshot.ts';

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

interface PassCommitmentInput {
  authority: Uint8Array;
  templateRaw: string;
}

/** Derivation must not enumerate or copy unrelated scanner, session, or other environment secrets. */
function liveAuthorityKey(env: object): Promise<CryptoKey> {
  const keys: Record<string, unknown> = {};
  for (const name of Object.keys(env)) {
    if (/^KEK_V\d+$/.test(name))
      Object.defineProperty(keys, name, { enumerable: true, get: () => Reflect.get(env, name) });
  }
  return derivedHmacKey(keys, 'scan-live-pass-authority.v1');
}

/** Only the four original photo lineage fields are authority; no raw photo object is retained. */
function photoAuthority(
  candidate: Candidate,
): { key: string; version: string; sha1: string; includeInPass: number } | null | undefined {
  const property = Object.getOwnPropertyDescriptor(candidate, 'assetPhoto');
  if (!property || !('value' in property)) return undefined;
  const photo: unknown = property.value;
  if (photo === null) return null;
  if (!photo || typeof photo !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(photo);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const key = Object.getOwnPropertyDescriptor(photo, 'key');
  const version = Object.getOwnPropertyDescriptor(photo, 'version');
  const sha1 = Object.getOwnPropertyDescriptor(photo, 'sha1');
  const included = Object.getOwnPropertyDescriptor(photo, 'includeInPass');
  if (
    !key ||
    !('value' in key) ||
    typeof key.value !== 'string' ||
    !key.value ||
    !version ||
    !('value' in version) ||
    typeof version.value !== 'string' ||
    !version.value ||
    !sha1 ||
    !('value' in sha1) ||
    typeof sha1.value !== 'string' ||
    !/^[a-f0-9]{40}$/.test(sha1.value) ||
    !included ||
    !('value' in included) ||
    (included.value !== 0 && included.value !== 1)
  )
    return undefined;
  if (
    key.value.length + version.value.length + sha1.value.length > MAX_D1_ROW_BYTES ||
    utf8Length(key.value) + utf8Length(version.value) + utf8Length(sha1.value) > MAX_D1_ROW_BYTES
  )
    return undefined;
  return {
    key: key.value,
    version: version.value,
    sha1: sha1.value,
    includeInPass: included.value,
  };
}

/** Capture evaluated disclosure authority before yielding to asynchronous work. */
function passCommitmentInput(candidate: Candidate): PassCommitmentInput | null {
  try {
    const templateRaw = candidate.templateSnapshot?.raw;
    if (typeof templateRaw !== 'string' || templateRaw.length === 0) return null;
    const pass = candidate.pass;
    const imageGeneration = pass.imageGeneration;
    const photo = photoAuthority(candidate);
    const credentialTombstoneRefs = candidate.credentialTombstoneRefs;
    const otherModeCredentialTombstoneRefs = candidate.otherModeCredentialTombstoneRefs;
    const credentialKeysetCommitment = candidate.credentialKeysetCommitment;
    if (!Number.isSafeInteger(imageGeneration) || imageGeneration < 0 || photo === undefined)
      return null;
    if (candidate.transferPending !== false) return null;
    if (
      !validCredentialTombstoneRefs(credentialTombstoneRefs) ||
      !validCredentialTombstoneRefs(otherModeCredentialTombstoneRefs) ||
      typeof credentialKeysetCommitment !== 'string' ||
      !/^[a-f0-9]{64}$/.test(credentialKeysetCommitment)
    )
      return null;
    if (
      (candidate.lookupHash != null && typeof candidate.lookupHash !== 'string') ||
      (candidate.hasPhoto !== undefined && typeof candidate.hasPhoto !== 'boolean') ||
      (candidate.checkInRules !== undefined &&
        !CheckInPolicySchema.safeParse(candidate.checkInRules).success) ||
      typeof candidate.passPersonalizationSnapshot !== 'string' ||
      typeof candidate.fieldSourcesSnapshot !== 'string' ||
      candidate.passPersonalizationSnapshot.length + candidate.fieldSourcesSnapshot.length >
        MAX_D1_ROW_BYTES ||
      utf8Length(candidate.passPersonalizationSnapshot) +
        utf8Length(candidate.fieldSourcesSnapshot) >
        MAX_D1_ROW_BYTES ||
      !pass.fieldSources ||
      typeof pass.fieldSources !== 'object' ||
      Array.isArray(pass.fieldSources)
    )
      return null;
    if (
      !Number.isSafeInteger(pass.credentialGeneration) ||
      pass.credentialGeneration <= 0 ||
      !Number.isSafeInteger(pass.lifecycleGeneration) ||
      pass.lifecycleGeneration < 0
    )
      return null;
    if (
      typeof candidate.identityRevision !== 'number' ||
      !Number.isSafeInteger(candidate.identityRevision) ||
      candidate.identityRevision <= 0
    )
      return null;
    if (
      typeof candidate.walletVersion !== 'number' ||
      !Number.isSafeInteger(candidate.walletVersion) ||
      candidate.walletVersion <= 0 ||
      candidate.walletVersion > candidate.pass.version ||
      (candidate.versionPersonalization !== null &&
        typeof candidate.versionPersonalization !== 'string') ||
      (candidate.walletTemplateVersion !== null &&
        typeof candidate.walletTemplateVersion !== 'string')
    )
      return null;
    const rawWallet = candidate.passJsonSnapshot;
    const rawPassJson = candidate.passJson;
    const rawPersonalization = candidate.versionPersonalization;
    const rawTemplateVersion = candidate.walletTemplateVersion;
    if (
      !rawWallet ||
      rawWallet.length + (rawPersonalization?.length ?? 0) + (rawTemplateVersion?.length ?? 0) >
        MAX_D1_ROW_BYTES
    )
      return null;
    if (
      utf8Length(rawWallet) +
        (rawPersonalization === null ? 0 : utf8Length(rawPersonalization)) +
        (rawTemplateVersion === null ? 0 : utf8Length(rawTemplateVersion)) >
      MAX_D1_ROW_BYTES
    )
      return null;
    if (
      rawPassJson !== rawWallet &&
      rawPassJson !== null &&
      (typeof rawPassJson !== 'string' ||
        rawPassJson.length > MAX_D1_ROW_BYTES ||
        utf8Length(rawPassJson) > MAX_D1_ROW_BYTES)
    )
      return null;
    const wallet: unknown = JSON.parse(rawWallet);
    if (!walletIdentityMatches(candidate, wallet)) return null;
    const authority = {
      pass: {
        id: pass.id,
        orgId: pass.orgId,
        mode: pass.mode,
        identityId: pass.identityId,
        serial: pass.serial,
        templateId: pass.templateId,
        templateVersion: pass.templateVersion,
        releaseId: pass.releaseId,
        version: pass.version,
        revision: pass.revision,
        linkGeneration: pass.linkGeneration,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        imageGeneration,
        status: pass.status,
        removedAt: pass.removedAt,
        deletedAt: pass.deletedAt,
        testDataQuarantined: pass.testDataQuarantined,
        personalization: pass.personalization,
        fieldSources: pass.fieldSources,
        displayTitle: pass.displayTitle,
        displaySubtitle: pass.displaySubtitle,
        externalId: pass.externalId,
        holderEmail: pass.holderEmail,
        ownerUserId: pass.ownerUserId,
        downloadToken: pass.downloadToken,
        authToken: pass.authToken,
        webServiceUrl: pass.webServiceUrl,
        objectKey: pass.objectKey,
        objectSha256: pass.objectSha256,
        objectSize: pass.objectSize,
        createdAt: pass.createdAt,
        modifiedAt: pass.modifiedAt,
        modifiedCollision: pass.modifiedCollision,
        syncErrorCode: pass.syncErrorCode,
        refreshRequestedAt: pass.refreshRequestedAt,
        lastRefreshedAt: pass.lastRefreshedAt,
        contentHash: pass.contentHash,
        scanCode: pass.scanCode,
        barcodeHash: pass.barcodeHash,
        connectionId: pass.connectionId,
        externalRef: pass.externalRef,
      },
      assetPhoto: photo,
      lookupHash:
        candidate.lookupHash === undefined ? ['undefined'] : ['value', candidate.lookupHash],
      checkInRules:
        candidate.checkInRules === undefined ? ['undefined'] : ['value', candidate.checkInRules],
      hasPhoto: candidate.hasPhoto === undefined ? ['undefined'] : ['value', candidate.hasPhoto],
      passPersonalizationSnapshot: candidate.passPersonalizationSnapshot,
      fieldSourcesSnapshot: candidate.fieldSourcesSnapshot,
      transferPending: candidate.transferPending,
      credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs,
      credentialKeysetCommitment,
      connectionGeneration: candidate.connectionGeneration,
      activeTemplateVersion: candidate.activeTemplateVersion,
      displayTemplateVersion: candidate.displayTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      activeReleaseId: candidate.activeReleaseId,
      activeReleaseGeneration: candidate.activeReleaseGeneration,
      activeReleaseVersion: candidate.activeReleaseVersion,
      activeReleaseCandidateHash: candidate.activeReleaseCandidateHash,
      identityRevision: candidate.identityRevision,
      identityPassTypeIdentifier: candidate.identityPassTypeIdentifier,
      identityTeamIdentifier: candidate.identityTeamIdentifier,
      walletVersion: candidate.walletVersion,
      walletTemplateVersion: candidate.walletTemplateVersion,
      versionPersonalization: candidate.versionPersonalization,
      passJson: rawPassJson === rawWallet ? ['same'] : ['value', rawPassJson],
      wallet: rawWallet,
    };
    const canonical = canonicalAuthority(authority);
    return canonical === null ? null : { authority: encoder.encode(canonical), templateRaw };
  } catch {
    return null;
  }
}

async function commitmentMessage(input: PassCommitmentInput): Promise<Uint8Array> {
  // Bind exact template bytes without putting unbounded template extras in the proof.
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(input.templateRaw)),
  );
  const message = new Uint8Array(input.authority.length + digest.length);
  message.set(input.authority);
  message.set(digest, input.authority.length);
  return message;
}

/** Pin the KEK and capture authority bytes before either asynchronous operation can resume. */
export async function livePassCommitment(
  env: object,
  candidate: Candidate,
): Promise<string | null> {
  // Starting derivation first pins the KEK without cloning the environment or its other secrets.
  const pendingKey = liveAuthorityKey(env);
  const input = passCommitmentInput(candidate);
  if (!input) {
    await pendingKey.catch(() => null);
    return null;
  }
  const [key, message] = await Promise.all([pendingKey, commitmentMessage(input)]);
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, message as BufferSource)),
  );
}

/** Verify a sealed commitment in constant time against a freshly read candidate. */
export async function livePassCommitmentValid(
  env: object,
  candidate: Candidate,
  commitment: string | null,
): Promise<boolean> {
  if (!commitment || !/^[A-Za-z0-9_-]{43}$/.test(commitment)) return false;
  try {
    const tag = fromBase64Url(commitment);
    if (tag.length !== 32 || toBase64Url(tag) !== commitment) return false;
    const pendingKey = liveAuthorityKey(env);
    const input = passCommitmentInput(candidate);
    if (!input) {
      await pendingKey.catch(() => null);
      return false;
    }
    const [key, message] = await Promise.all([pendingKey, commitmentMessage(input)]);
    return await crypto.subtle.verify('HMAC', key, tag as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}
