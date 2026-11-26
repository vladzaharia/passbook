import type { z } from 'zod';
import type { WebhookCaptureDto } from '../../../shared/contracts/webhook-captures.ts';
import type { OverlapHours } from '../../../shared/contracts/webhook-secrets.ts';
import type { WebhookTestAttemptSchema } from '../../../shared/contracts/webhook-tests.ts';
import type {
  WebhookDeliveryDetailSchema,
  WebhookDeliverySchema,
  WebhookEndpointDto,
} from '../../../shared/contracts/webhooks.ts';

export type DeliveryDto = z.infer<typeof WebhookDeliverySchema>;
export type DeliveryDetailDto = z.infer<typeof WebhookDeliveryDetailSchema>;
export type TestAttemptDto = z.infer<typeof WebhookTestAttemptSchema>;
export interface TestSent {
  captureId: string | null;
  ok: boolean;
  status: number | null;
  errorCode: string | null;
}

/** A problem+json answer. `code` is the API's stable code. */
export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  /** Set on `STEP_UP_REQUIRED`: where the sign-in goes. */
  readonly signInUrl: string | undefined;
  constructor(status: number, code: string, message: string, signInUrl?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.signInUrl = signInUrl;
  }
}

/** The sign-in URL when the server asked for a recent sign-in (possibly empty), else null. */
export function stepUpOf(e: unknown): string | null {
  return e instanceof ApiProblem &&
    (e.code === 'STEP_UP_REQUIRED' || e.code === 'IDP_SIGN_IN_REQUIRED')
    ? (e.signInUrl ?? '')
    : null;
}

export type TesterAuth =
  | { kind: 'signed-out' }
  | { kind: 'no-sandbox' }
  | { kind: 'ready'; api: TesterApi };

/** What narrows a list: the event type, the API request that caused it, the pass it is about. */
export interface FeedQuery {
  type?: string;
  requestId?: string;
  passId?: string;
}

const queryOf = (limit: number, q: FeedQuery) => {
  const p = new URLSearchParams({ limit: String(limit) });
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  return p.toString();
};

export interface TesterApi {
  endpoints(): Promise<WebhookEndpointDto[]>;
  /** The sandbox's capture endpoint, made if it has none. */
  ensureCapture(): Promise<WebhookEndpointDto>;
  captures(id: string, q?: FeedQuery): Promise<WebhookCaptureDto[]>;
  sendTest(id: string, type: string): Promise<TestSent>;
  /** A URL endpoint, signed with a secret that shows once. */
  createEndpoint(
    url: string,
    eventTypes: string[],
  ): Promise<{ endpoint: WebhookEndpointDto; secret: string }>;
  deliveries(id: string, q?: FeedQuery): Promise<DeliveryDto[]>;
  delivery(id: string, eventId: string): Promise<DeliveryDetailDto>;
  tests(id: string): Promise<TestAttemptDto[]>;
  replayDelivery(id: string, eventId: string): Promise<void>;
  /** A new signing secret, returned once; the old one keeps signing for `overlapHours`. */
  rotate(id: string, overlapHours: OverlapHours): Promise<string>;
  replay(id: string, captureId: string): Promise<WebhookCaptureDto>;
  secret(id: string): Promise<string>;
}

const REFRESH_BEFORE_MS = 60_000;

async function problem(res: Response): Promise<ApiProblem> {
  let body: { code?: unknown; detail?: unknown; title?: unknown; signInUrl?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Not JSON: the status says enough.
  }
  const text = [body.detail, body.title].find((v) => typeof v === 'string');
  return new ApiProblem(
    res.status,
    typeof body.code === 'string' ? body.code : 'ERROR',
    typeof text === 'string' ? text : `The request failed (${res.status}).`,
    typeof body.signInUrl === 'string' ? body.signInUrl : undefined,
  );
}

/**
 * Signed in through the session cookie, calling the API with a try token (15 minutes, Test only, this
 * sandbox only): the page never holds a key. A 401 mid-session gets one new token, then gives up.
 */
export async function connect(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  now: () => number = Date.now,
): Promise<TesterAuth> {
  let token: { value: string; expiresAt: number } | null = null;
  let csrf = '';
  let known = false;

  async function mint(): Promise<'ok' | 'signed-out' | 'no-sandbox'> {
    const session = await fetchFn('/api/v1/session', { headers: { accept: 'application/json' } });
    if (!session.ok) throw await problem(session);
    const state = (await session.json()) as { authenticated: boolean; csrfToken?: string };
    if (!state.authenticated) return 'signed-out';
    csrf = state.csrfToken ?? '';
    // Without a sandbox there is no token to ask for: say so without a call that can only 404.
    if (!known) {
      const box = await fetchFn('/api/v1/developer/sandbox', {
        headers: { accept: 'application/json' },
      });
      if (!box.ok) throw await problem(box);
      const { sandbox } = (await box.json()) as { sandbox?: { closedAt?: unknown } | null };
      if (!sandbox || sandbox.closedAt) return 'no-sandbox';
      known = true;
    }
    const res = await fetchFn('/api/v1/developer/try-token', {
      method: 'POST',
      headers: { accept: 'application/json', 'x-csrf-token': csrf },
    });
    if (res.status === 404) return 'no-sandbox';
    if (!res.ok) throw await problem(res);
    const body = (await res.json()) as { token: string; expiresAt: number };
    token = { value: body.token, expiresAt: body.expiresAt };
    return 'ok';
  }

  async function call<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    if (!token || token.expiresAt - now() < REFRESH_BEFORE_MS) await mint();
    const res = await fetchFn(`/api/v1${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token?.value ?? ''}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 && retry) {
      token = null;
      return call<T>(method, path, body, false);
    }
    if (!res.ok) throw await problem(res);
    return (await res.json()) as T;
  }

  const first = await mint();
  if (first !== 'ok') return { kind: first };
  const base = (id: string) => `/webhook-endpoints/${encodeURIComponent(id)}`;
  return {
    kind: 'ready',
    api: {
      endpoints: async () =>
        (await call<{ items: WebhookEndpointDto[] }>('GET', '/webhook-endpoints')).items,
      ensureCapture: async () =>
        (await call<{ endpoint: WebhookEndpointDto }>('POST', '/webhook-endpoints/capture', {}))
          .endpoint,
      captures: async (id, q = {}) =>
        (
          await call<{ items: WebhookCaptureDto[] }>(
            'GET',
            `${base(id)}/captures?${queryOf(50, q)}`,
          )
        ).items,
      sendTest: (id, type) => call<TestSent>('POST', `${base(id)}/test`, { type }),
      createEndpoint: (url, eventTypes) =>
        call<{ endpoint: WebhookEndpointDto; secret: string }>('POST', '/webhook-endpoints', {
          url,
          eventTypes,
        }),
      deliveries: async (id, q = {}) =>
        (
          await call<{ items: DeliveryDto[] }>(
            'GET',
            `${base(id)}/deliveries?${queryOf(30, { requestId: q.requestId, passId: q.passId })}`,
          )
        ).items,
      delivery: (id, eventId) =>
        call<DeliveryDetailDto>('GET', `${base(id)}/deliveries/${encodeURIComponent(eventId)}`),
      replayDelivery: async (id, eventId) => {
        await call('POST', `${base(id)}/deliveries/${encodeURIComponent(eventId)}/replay`);
      },
      rotate: async (id, overlapHours) =>
        (await call<{ secret: string }>('POST', `${base(id)}/secret`, { overlapHours })).secret,
      tests: async (id) =>
        (await call<{ items: TestAttemptDto[] }>('GET', `${base(id)}/tests`)).items,
      replay: (id, captureId) =>
        call<WebhookCaptureDto>(
          'POST',
          `${base(id)}/captures/${encodeURIComponent(captureId)}/replay`,
        ),
      secret: async (id) =>
        (await call<{ secret: string }>('POST', `${base(id)}/captures/secret`)).secret,
    },
  };
}
