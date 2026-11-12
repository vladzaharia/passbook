import { constants, publicEncrypt } from 'node:crypto';
import { CompactSign } from 'jose';
import { toBase64Url } from '../../platform/ids.ts';
import {
  assertSamsungCredentialsCurrent,
  type ValidatedSamsungCallbackCredentials,
  type ValidatedSamsungCredentials,
} from './samsung-credentials.ts';
import { SamsungTokenError } from './samsung-token-errors.ts';
import {
  SAMSUNG_CLOCK_SKEW_MS,
  type SamsungInboundRequestInput,
  type VerifiedSamsungRequest,
  verifySamsungInboundRequest,
} from './samsung-token-inbound.ts';

export { SamsungReplayStoreError, SamsungTokenError } from './samsung-token-errors.ts';
export type { VerifiedSamsungRequest } from './samsung-token-inbound.ts';

const encoder = new TextEncoder();

export type SamsungCardState =
  | 'ACTIVE'
  | 'UPDATED'
  | 'EXPIRED'
  | 'REDEEMED'
  | 'HELD'
  | 'DELETED'
  | 'CANCELED'
  | 'PENDING'
  | 'SUSPENDED';

interface SamsungCardItem {
  refId: string;
  createdAt: number;
  updatedAt: number;
  state: SamsungCardState;
  language: string;
  attributes: Record<string, unknown>;
  localization?: { language: string; attributes: Record<string, unknown> }[];
}

/** The issuer's approved provider projection; this module does not approve or map card fields. */
export interface SamsungCardProjection {
  card: { type: string; subType: string; data: SamsungCardItem[] };
}

function header(account: ValidatedSamsungCredentials, cty: 'AUTH' | 'CARD', now: number) {
  return {
    alg: 'RS256',
    cty,
    ver: '3',
    certificateId: account.certificateId,
    partnerId: account.partnerId,
    utc: now,
  };
}

/** Samsung's v3 JWS header and request-binding payload: https://developer.samsung.com/wallet/securityauthentication/restapiauthorizationtoken.html */
export async function createSamsungAuthorizationToken(
  account: ValidatedSamsungCredentials,
  input: { method: 'GET' | 'POST'; path: string; refId?: string; now?: number },
): Promise<string> {
  const now = input.now ?? Date.now();
  assertSamsungCredentialsCurrent(account, now);
  if (
    (input.method !== 'GET' && input.method !== 'POST') ||
    typeof input.path !== 'string' ||
    !/^\/[A-Za-z0-9/_-]{1,511}$/.test(input.path) ||
    (input.refId !== undefined &&
      (typeof input.refId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(input.refId)))
  )
    throw new SamsungTokenError();
  const payload = {
    API: { method: input.method, path: input.path },
    ...(input.refId === undefined ? {} : { refId: input.refId }),
  };
  try {
    return await new CompactSign(encoder.encode(JSON.stringify(payload)))
      .setProtectedHeader(header(account, 'AUTH', now))
      .sign(account.partnerSigningKey);
  } catch {
    throw new SamsungTokenError();
  }
}

function checkProjection(projection: SamsungCardProjection): void {
  const card = projection?.card;
  const states: readonly string[] = [
    'ACTIVE',
    'UPDATED',
    'EXPIRED',
    'REDEEMED',
    'HELD',
    'DELETED',
    'CANCELED',
    'PENDING',
    'SUSPENDED',
  ];
  if (
    !card ||
    typeof card.type !== 'string' ||
    !/^[a-z]{1,16}$/.test(card.type) ||
    typeof card.subType !== 'string' ||
    !/^[a-z]{1,16}$/.test(card.subType) ||
    !Array.isArray(card.data) ||
    card.data.length < 1 ||
    card.data.length > 6
  )
    throw new SamsungTokenError();
  for (const item of card.data) {
    if (
      !item ||
      typeof item.refId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(item.refId) ||
      !Number.isSafeInteger(item.createdAt) ||
      !Number.isSafeInteger(item.updatedAt) ||
      !states.includes(item.state) ||
      typeof item.language !== 'string' ||
      !/^[A-Za-z-]{1,8}$/.test(item.language) ||
      !item.attributes ||
      typeof item.attributes !== 'object' ||
      Array.isArray(item.attributes)
    )
      throw new SamsungTokenError();
  }
}

/** JWS(RSA1_5/A128GCM JWE(card)): https://developer.samsung.com/wallet/securityauthentication/carddatatoken.html */
export async function createSamsungCardDataToken(
  account: ValidatedSamsungCredentials,
  projection: SamsungCardProjection,
  now = Date.now(),
): Promise<string> {
  assertSamsungCredentialsCurrent(account, now);
  checkProjection(projection);
  try {
    const protectedHeader = toBase64Url(
      encoder.encode(JSON.stringify({ alg: 'RSA1_5', enc: 'A128GCM' })),
    );
    const cek = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(protectedHeader), tagLength: 128 },
        aes,
        encoder.encode(JSON.stringify(projection)),
      ),
    );
    // Web Crypto does not implement RSAES-PKCS1-v1_5 key wrapping; use Workers' native node:crypto for that operation only.
    const encryptedKey = publicEncrypt(
      { key: account.samsungCertificatePem, padding: constants.RSA_PKCS1_PADDING },
      cek,
    );
    const jwe = [
      protectedHeader,
      toBase64Url(encryptedKey),
      toBase64Url(iv),
      toBase64Url(encrypted.subarray(0, -16)),
      toBase64Url(encrypted.subarray(-16)),
    ].join('.');
    return await new CompactSign(encoder.encode(jwe))
      .setProtectedHeader(header(account, 'CARD', now))
      .sign(account.partnerSigningKey);
  } catch {
    throw new SamsungTokenError();
  }
}

const verifiedRequests = new WeakMap<VerifiedSamsungRequest, ValidatedSamsungCredentials>();

/** Verifies a live request and creates an in-process capability for rendering approved card data. */
export async function verifySamsungRequest(
  account: ValidatedSamsungCredentials,
  input: SamsungInboundRequestInput,
): Promise<VerifiedSamsungRequest> {
  const now = input.now ?? Date.now();
  assertSamsungCredentialsCurrent(account, now);
  const result = await verifySamsungInboundRequest(account, { ...input, now });
  verifiedRequests.set(result, account);
  return result;
}

/** Authenticates a historical callback without loading any partner signing key or card data. */
export function verifySamsungTombstoneRequest(
  account: ValidatedSamsungCallbackCredentials,
  input: SamsungInboundRequestInput,
): Promise<VerifiedSamsungRequest> {
  return verifySamsungInboundRequest(account, input);
}

/** Only use a freshly verified GET and the issuer-approved projection for that same refId. */
export async function samsungCardDataResponse(
  account: ValidatedSamsungCredentials,
  request: VerifiedSamsungRequest,
  projection: SamsungCardProjection,
  now = Date.now(),
): Promise<{ cdata: string }> {
  assertSamsungCredentialsCurrent(account, now);
  if (
    verifiedRequests.get(request) !== account ||
    request.method !== 'GET' ||
    request.partnerId !== account.partnerId ||
    request.certificateId !== account.certificateId ||
    request.cardId !== account.cardId ||
    now < request.signedAt - SAMSUNG_CLOCK_SKEW_MS ||
    now >= request.replayExpiresAt ||
    !projection?.card ||
    !Array.isArray(projection.card.data) ||
    projection.card.data.length !== 1 ||
    projection.card.data[0]?.refId !== request.refId
  )
    throw new SamsungTokenError();
  return { cdata: await createSamsungCardDataToken(account, projection, now) };
}
