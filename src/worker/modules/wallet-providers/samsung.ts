import { toBase64Url } from '../../platform/ids.ts';
import {
  assertSamsungCredentialsCurrent,
  type ValidatedSamsungCredentials,
} from './samsung-credentials.ts';
import { createSamsungAuthorizationToken, type SamsungCardState } from './samsung-token.ts';

export {
  SamsungCredentialError,
  type SamsungPartnerCredentials,
  type ValidatedSamsungCredentials,
  validateSamsungCallbackCredentials,
  validateSamsungCredentials,
} from './samsung-credentials.ts';
export { probeSamsungActiveTemplate, SamsungTemplateError } from './samsung-template.ts';
export {
  createSamsungCardDataToken,
  type SamsungCardProjection,
  type SamsungCardState,
  SamsungReplayStoreError,
  SamsungTokenError,
  samsungCardDataResponse,
  type VerifiedSamsungRequest,
  verifySamsungRequest,
  verifySamsungTombstoneRequest,
} from './samsung-token.ts';

const PUBLIC_ORIGIN = 'https://tsapi-card.walletsvc.samsung.com';
const MAX_ATTEMPTS = 3;
const MAX_RETRY_MS = 300_000;

/** 192 random bits fit Samsung's documented 32-character Get Card Data refId limit. */
export function createSamsungRefId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}

/**
 * Data Fetch link: https://developer.samsung.com/wallet/addtosamsungwallet/apiguidelines.html#Data-Fetch-Link
 * pdata remains a bearer capability after initial fetch, since Samsung also uses it for refresh.
 * The caller must gate disclosure with a separately expiring offer and authenticate every fetch.
 */
export function buildSamsungDataFetchLink(
  account: ValidatedSamsungCredentials,
  refId: string,
  now = Date.now(),
): string {
  assertSamsungCredentialsCurrent(account, now);
  if (typeof refId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(refId))
    throw new SamsungNotificationError({
      kind: 'invalid_request',
      retryable: false,
      ambiguous: false,
    });
  return `https://a.swallet.link/atw/v3/${account.certificateId}/${account.cardId}#Clip?pdata=${refId}`;
}

export type SamsungFailureKind =
  | 'invalid_request'
  | 'authentication'
  | 'not_found'
  | 'rate_limit'
  | 'unavailable'
  | 'network'
  | 'protocol';

export interface SamsungFailure {
  kind: SamsungFailureKind;
  status?: number;
  retryable: boolean;
  /** A failed transport/5xx can have reached Samsung. Retrying may duplicate notifications. */
  ambiguous: boolean;
  retryAfterMs?: number;
}

export class SamsungNotificationError extends Error {
  readonly kind: SamsungFailureKind;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(failure: SamsungFailure) {
    super('Samsung Wallet notification failed.');
    this.name = 'SamsungNotificationError';
    this.kind = failure.kind;
    this.status = failure.status;
    this.retryable = failure.retryable;
    this.ambiguous = failure.ambiguous;
    this.retryAfterMs = failure.retryAfterMs;
  }
}

/** A recommendation only: no internal retries or assumed idempotency. Attempts are 1-based. */
export function classifySamsungFailure(input: {
  status?: number;
  attempt: number;
  retryAfter?: string | null;
  now?: number;
}): SamsungFailure {
  if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > MAX_ATTEMPTS)
    return { kind: 'invalid_request', retryable: false, ambiguous: false };
  const { status, attempt } = input;
  const kind: SamsungFailureKind =
    status === undefined
      ? 'network'
      : status === 204 || status === 404
        ? 'not_found'
        : status === 401 || status === 403
          ? 'authentication'
          : status === 400 || status === 422
            ? 'invalid_request'
            : status === 429
              ? 'rate_limit'
              : [408, 500, 502, 503, 504].includes(status)
                ? 'unavailable'
                : 'protocol';
  const transient = kind === 'network' || kind === 'rate_limit' || kind === 'unavailable';
  const ambiguous = kind === 'network' || kind === 'unavailable';
  const retryable = transient && attempt < MAX_ATTEMPTS;
  let delay = 1000 * 2 ** (attempt - 1);
  const value = input.retryAfter?.trim();
  if (value && /^\d+$/.test(value)) delay = Number(value) * 1000;
  else if (value) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) delay = Math.max(0, date - (input.now ?? Date.now()));
  }
  if (!Number.isFinite(delay)) delay = MAX_RETRY_MS;
  return {
    kind,
    status,
    retryable,
    ambiguous,
    ...(retryable ? { retryAfterMs: Math.min(MAX_RETRY_MS, delay) } : {}),
  };
}

export interface SamsungUpdateInput {
  cc2: string;
  type: string;
  refId: string;
  state: SamsungCardState;
  attempt: number;
  now?: number;
}

export interface SamsungCancelInput {
  cc2: string;
  type: 'ticket';
  eventId: string;
  attempt: number;
  now?: number;
}

function invalidRequest(): SamsungNotificationError {
  return new SamsungNotificationError({
    kind: 'invalid_request',
    retryable: false,
    ambiguous: false,
  });
}

async function sendNotification(
  account: ValidatedSamsungCredentials,
  input: {
    cc2: string;
    action: 'updates' | 'cancels';
    body: object;
    retirement: boolean;
    attempt: number;
    now?: number;
  },
  fetcher: typeof fetch,
): Promise<void> {
  const now = input.now ?? Date.now();
  assertSamsungCredentialsCurrent(account, now);
  if (
    typeof input.cc2 !== 'string' ||
    !/^[A-Za-z]{2}$/.test(input.cc2) ||
    !Number.isInteger(input.attempt) ||
    input.attempt < 1 ||
    input.attempt > MAX_ATTEMPTS
  )
    throw invalidRequest();
  const path = `/${input.cc2}/wltex/cards/${account.cardId}/${input.action}`;
  const authorization = await createSamsungAuthorizationToken(account, {
    method: 'POST',
    path,
    now,
  });
  let response: Response;
  try {
    response = await fetcher(`${PUBLIC_ORIGIN}${path}`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${authorization}`,
        'Content-Type': 'application/json',
        'x-smcs-partner-id': account.partnerId,
        'x-request-id': crypto.randomUUID().replaceAll('-', ''),
      },
      body: JSON.stringify(input.body),
    });
  } catch {
    throw new SamsungNotificationError(classifySamsungFailure({ attempt: input.attempt, now }));
  }
  // A 204 means the card is absent; only retirement may treat that as provider-side acceptance.
  // Neither this nor any other 2xx proves removal from a device.
  if (
    response.status !== 200 &&
    !(input.retirement && response.status >= 200 && response.status < 300)
  )
    throw new SamsungNotificationError(
      classifySamsungFailure({
        status: response.status,
        attempt: input.attempt,
        retryAfter: response.headers.get('Retry-After'),
        now,
      }),
    );
}

/** https://developer.samsung.com/wallet/addtosamsungwallet/apiguidelines.html#Update-Notification */
export async function sendSamsungUpdate(
  account: ValidatedSamsungCredentials,
  input: SamsungUpdateInput,
  fetcher: typeof fetch = fetch,
): Promise<void> {
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
  // Samsung's overview excludes Generic and Gift Card updates, despite conflicting generic examples.
  // https://developer.samsung.com/wallet/addtosamsungwallet/overview.html#Update-Wallet-Cards
  if (
    typeof input.type !== 'string' ||
    !/^[a-z]{1,16}$/.test(input.type) ||
    input.type === 'generic' ||
    input.type === 'giftcard' ||
    typeof input.refId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(input.refId) ||
    !states.includes(input.state) ||
    ('fields' in input && input.fields !== undefined)
  )
    throw invalidRequest();
  const item = { refId: input.refId, state: input.state };
  await sendNotification(
    account,
    {
      cc2: input.cc2,
      action: 'updates',
      body: { card: { type: input.type, data: [item] } },
      retirement: input.state === 'DELETED',
      attempt: input.attempt,
      now: input.now,
    },
    fetcher,
  );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Event-wide cancellation, not a per-ref removal. */
export async function sendSamsungCancel(
  account: ValidatedSamsungCredentials,
  input: SamsungCancelInput,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (
    input.type !== 'ticket' ||
    typeof input.eventId !== 'string' ||
    input.eventId.length < 1 ||
    input.eventId.length > 32 ||
    hasControlCharacters(input.eventId)
  )
    throw invalidRequest();
  await sendNotification(
    account,
    {
      cc2: input.cc2,
      action: 'cancels',
      body: { card: { type: 'ticket', data: [{ eventId: input.eventId, state: 'CANCELED' }] } },
      retirement: true,
      attempt: input.attempt,
      now: input.now,
    },
    fetcher,
  );
}
