import { type CompactVerifyResult, compactVerify } from 'jose';
import { sha256Base64Url } from '../../platform/ids.ts';
import {
  assertSamsungCallbackCredentialsCurrent,
  type ValidatedSamsungCallbackCredentials,
} from './samsung-credentials.ts';
import { SamsungReplayStoreError, SamsungTokenError } from './samsung-token-errors.ts';

const decoder = new TextDecoder();
const TOKEN_AGE_MS = 30_000;
export const SAMSUNG_CLOCK_SKEW_MS = 5_000;

export interface VerifiedSamsungRequest {
  readonly method: 'GET' | 'POST';
  readonly partnerId: string;
  readonly certificateId: string;
  readonly cardId: string;
  readonly refId: string;
  readonly requestId: string;
  readonly signedAt: number;
  readonly replayKey: string;
  readonly replayExpiresAt: number;
  /** True only if a nonempty query was included verbatim in the signed API.path. */
  readonly queryBound: boolean;
}

export interface SamsungInboundRequestInput {
  request: Request;
  refId: string;
  method: 'GET' | 'POST';
  /** Atomically reserve across Workers; return false for a duplicate and fail closed on store errors. */
  claimReplay: (
    key: string,
    expiresAt: number,
    signedAt: number,
    queryBound: boolean,
  ) => Promise<boolean>;
  now?: number;
}

export async function verifySamsungInboundRequest(
  account: ValidatedSamsungCallbackCredentials,
  input: SamsungInboundRequestInput,
): Promise<VerifiedSamsungRequest> {
  const now = input.now ?? Date.now();
  assertSamsungCallbackCredentialsCurrent(account, now);
  const { request, refId } = input;
  if (
    typeof refId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(refId) ||
    (input.method !== 'GET' && input.method !== 'POST') ||
    request.method !== input.method ||
    typeof input.claimReplay !== 'function'
  )
    throw new SamsungTokenError();
  const url = new URL(request.url);
  if (!url.pathname.endsWith(`/cards/${account.cardId}/${refId}`)) throw new SamsungTokenError();
  const requestId = request.headers.get('x-request-id');
  if (!requestId || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw new SamsungTokenError();
  const authorization = request.headers.get('Authorization');
  const match = authorization?.match(
    /^(?:Bearer\s+)?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i,
  );
  const token = match?.[1];
  if (!token || token.length > 4096) throw new SamsungTokenError();
  let verified: CompactVerifyResult;
  let payload: { API?: { method?: unknown; path?: unknown }; refId?: unknown };
  try {
    verified = await compactVerify(token, account.samsungVerificationKey, {
      algorithms: ['RS256'],
    });
    payload = JSON.parse(decoder.decode(verified.payload));
  } catch {
    throw new SamsungTokenError();
  }
  const h = verified.protectedHeader;
  const utc = h.utc;
  const signedPath = payload?.API?.path;
  const queryBound = url.search !== '' && signedPath === `${url.pathname}${url.search}`;
  if (
    h.cty !== 'AUTH' ||
    (h.ver !== '3' && h.ver !== 3) ||
    h.partnerId !== account.partnerId ||
    h.certificateId !== account.certificateId ||
    typeof utc !== 'number' ||
    !Number.isSafeInteger(utc) ||
    utc < account.validFrom ||
    utc >= account.validUntil ||
    utc > now + SAMSUNG_CLOCK_SKEW_MS ||
    utc < now - TOKEN_AGE_MS ||
    !payload ||
    payload.API?.method !== input.method ||
    // The primary spec signs only pathname; an older tutorial signs the query too.
    (signedPath !== url.pathname && !queryBound) ||
    (payload.refId !== undefined && payload.refId !== refId)
  )
    throw new SamsungTokenError();
  const replayKey = await sha256Base64Url(token);
  const replayExpiresAt = utc + TOKEN_AGE_MS + SAMSUNG_CLOCK_SKEW_MS;
  let claimed: boolean;
  try {
    claimed = await input.claimReplay(replayKey, replayExpiresAt, utc, queryBound);
  } catch {
    throw new SamsungReplayStoreError();
  }
  if (!claimed) throw new SamsungTokenError();
  return Object.freeze({
    method: input.method,
    partnerId: account.partnerId,
    certificateId: account.certificateId,
    cardId: account.cardId,
    refId,
    requestId,
    signedAt: utc,
    replayKey,
    replayExpiresAt,
    queryBound,
  });
}
