import { isGoogleIssuerId } from './google-credentials.ts';
import { googleBase64Url } from './google-crypto.ts';
import { GoogleWalletError } from './google-errors.ts';

export interface GoogleClassScope {
  tenantId: string;
  releaseId: string;
}

/** releaseId is the original class binding; credentialGeneration identifies the holder lineage. */
export interface GoogleObjectScope extends GoogleClassScope {
  passId: string;
  mode: 'live' | 'test';
  credentialGeneration: number;
  /** Absent means 1. Epoch 1 ids are the original derivation; a successor appends its epoch. */
  channelEpoch: number;
}

declare const derivedGoogleId: unique symbol;
/** An id this module derived from an enrolment's HMAC key; outbound Google calls take no other string. */
export type DerivedGoogleId = string & { readonly [derivedGoogleId]: true };

export interface GoogleWalletIds {
  classId: DerivedGoogleId;
  objectId: DerivedGoogleId;
}

async function idKey(
  issuerId: string,
  secret: Uint8Array,
  scope: GoogleClassScope,
): Promise<CryptoKey> {
  if (
    !isGoogleIssuerId(issuerId) ||
    !(secret instanceof Uint8Array) ||
    secret.byteLength < 32 ||
    typeof scope?.tenantId !== 'string' ||
    !scope.tenantId.trim() ||
    typeof scope.releaseId !== 'string' ||
    !scope.releaseId.trim()
  ) {
    throw new GoogleWalletError('invalid_input', 'identifiers');
  }
  return crypto.subtle.importKey(
    'raw',
    secret as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function derive(
  key: CryptoKey,
  issuerId: string,
  kind: 'class' | 'object',
  values: (string | number)[],
): Promise<DerivedGoogleId> {
  const message = JSON.stringify(['passbook-google-wallet-v1', issuerId, kind, ...values]);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return `${issuerId}.${kind === 'class' ? 'c' : 'o'}_${googleBase64Url(new Uint8Array(mac))}` as DerivedGoogleId;
}

/** The HMAC secret must remain stable when Google service-account keys rotate. */
export async function googleClassId(
  issuerId: string,
  secret: Uint8Array,
  scope: GoogleClassScope,
): Promise<DerivedGoogleId> {
  const key = await idKey(issuerId, secret, scope);
  return derive(key, issuerId, 'class', [scope.tenantId, scope.releaseId]);
}

export async function googleObjectIds(
  issuerId: string,
  secret: Uint8Array,
  scope: GoogleObjectScope,
): Promise<GoogleWalletIds> {
  if (
    typeof scope?.passId !== 'string' ||
    !scope.passId.trim() ||
    (scope.mode !== 'live' && scope.mode !== 'test') ||
    !Number.isSafeInteger(scope.credentialGeneration) ||
    scope.credentialGeneration <= 0 ||
    !Number.isSafeInteger(scope.channelEpoch) ||
    scope.channelEpoch < 1 ||
    scope.channelEpoch > 16
  ) {
    throw new GoogleWalletError('invalid_input', 'identifiers');
  }
  const key = await idKey(issuerId, secret, scope);
  const [classId, objectId] = await Promise.all([
    derive(key, issuerId, 'class', [scope.tenantId, scope.releaseId]),
    derive(key, issuerId, 'object', [
      scope.tenantId,
      scope.mode,
      scope.passId,
      scope.credentialGeneration,
      ...(scope.channelEpoch > 1 ? [scope.channelEpoch] : []),
    ]),
  ]);
  return { classId, objectId };
}
