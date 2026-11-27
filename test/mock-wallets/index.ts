export type MockProvider = 'google' | 'samsung' | 'control';

export interface MockRequestLog {
  n: number;
  provider: MockProvider;
  method: string;
  path: string;
  status: number;
  /** The status came from an injected failure, not the endpoint. */
  injected: boolean;
  /** Parsed JSON or form body; the Authorization header is never kept. */
  body?: unknown;
}

export interface MockFailure {
  status: number;
  /** Only requests whose `METHOD /path` matches; omit to match every provider request. */
  match?: RegExp | string;
  /** Requests to fail before the rule is spent; default 1. */
  times?: number;
  retryAfterSeconds?: number;
}

export interface MockSamsungTemplate {
  cardType: string;
  subType: string;
  countryCode: string;
  state: string;
  testingModeOff: 'Y' | 'N';
}

export interface MockWalletsOptions {
  /** Used for Samsung cards with no template set. */
  defaultSamsungTemplate?: MockSamsungTemplate;
  /** The clock `addMessage` counts notifications over; default `Date.now`. */
  now?: () => number;
}

const NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Google's documented cap of notifying messages per object per 24 h, and the assumed cap of messages held. */
const NOTIFY_LIMIT = 3;
const MESSAGE_CAP = 10;

type Doc = Record<string, unknown>;

const DEFAULT_TEMPLATE: MockSamsungTemplate = {
  cardType: 'ticket',
  subType: 'others',
  countryCode: 'US',
  state: 'ACTIVE',
  testingModeOff: 'Y',
};

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
/** Each type's class and object collection (google-wallet.md section 1). */
const CLASS_OF = {
  genericObject: 'genericClass',
  eventTicketObject: 'eventTicketClass',
  loyaltyObject: 'loyaltyClass',
  giftCardObject: 'giftCardClass',
  offerObject: 'offerClass',
} as const;
type ObjectResource = keyof typeof CLASS_OF;
type Resource = ObjectResource | (typeof CLASS_OF)[ObjectResource];
const RESOURCES = [...Object.keys(CLASS_OF), ...Object.values(CLASS_OF)] as Resource[];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const googleError = (status: number, message: string) =>
  json(status, { error: { code: status, message } });

function decodeJwt(token: string): { header: Doc; payload: Doc } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const part = (s: string) => JSON.parse(atob(s.replaceAll('-', '+').replaceAll('_', '/')));
    return { header: part(parts[0] as string), payload: part(parts[1] as string) };
  } catch {
    return null;
  }
}

/**
 * Local stand-in for the Google Wallet REST API and the Samsung Wallet partner API, with the
 * endpoints this repo calls. Same handler backs worker tests (call `handle` from a stubbed fetch)
 * and the Playwright/dev node server. State is in memory; failures are injected per request.
 * Signatures are not verified: tokens and JWTs are checked for shape, not provenance.
 */
export function createMockWallets(options: MockWalletsOptions = {}) {
  const google = Object.fromEntries(RESOURCES.map((name) => [name, new Map()])) as Record<
    Resource,
    Map<string, Doc>
  >;
  const tokens = new Set<string>();
  const saves: { objectIds: string[]; issuer: string; typ: unknown }[] = [];
  const samsungTemplates = new Map<string, MockSamsungTemplate>();
  const samsungRefs = new Map<string, { type: string; state: string; cardId: string }>();
  const samsungCancels: { cardId: string; eventId: string }[] = [];
  let callbackKeys: Doc[] = [];
  let failures: (MockFailure & { left: number })[] = [];
  let requests: MockRequestLog[] = [];
  let counter = 0;
  const now = options.now ?? Date.now;
  /** TEXT_AND_NOTIFY messages accepted per object, by time, for the 24 h limit. */
  const notifications = new Map<string, number[]>();

  function reset(): void {
    for (const store of Object.values(google)) store.clear();
    tokens.clear();
    saves.length = 0;
    samsungTemplates.clear();
    samsungRefs.clear();
    samsungCancels.length = 0;
    notifications.clear();
    callbackKeys = [];
    failures = [];
    requests = [];
  }

  function bearer(request: Request): string | null {
    const value = request.headers.get('authorization') ?? '';
    return value.startsWith('Bearer ') ? value.slice(7) : null;
  }

  async function oauth(body: URLSearchParams): Promise<Response> {
    if (body.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      return json(400, { error: 'unsupported_grant_type' });
    const jwt = decodeJwt(body.get('assertion') ?? '');
    if (!jwt || jwt.payload.scope !== GOOGLE_SCOPE || typeof jwt.payload.iss !== 'string')
      return json(400, { error: 'invalid_grant' });
    const token = `mock.${++counter}.${crypto.randomUUID().replaceAll('-', '')}`;
    tokens.add(token);
    return json(200, {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: GOOGLE_SCOPE,
    });
  }

  async function walletObjects(
    request: Request,
    segments: string[],
    body: Doc | undefined,
  ): Promise<Response> {
    const token = bearer(request);
    if (!token || !tokens.has(token)) return googleError(401, 'Invalid credentials');
    const [kind, rawId] = segments;
    const id = rawId ? decodeURIComponent(rawId) : undefined;
    if (kind === 'issuer' && id && request.method === 'GET')
      return json(200, { issuerId: id, name: `Mock issuer ${id}` });
    if (!RESOURCES.includes(kind as Resource)) return googleError(404, 'Not found');
    const store = google[kind as Resource];
    const isObject = kind !== undefined && kind in CLASS_OF;
    if (segments[2] === 'addMessage') {
      if (!isObject || !id || request.method !== 'POST')
        return googleError(405, 'Method not allowed');
      return addMessage(kind as ObjectResource, id, store, body);
    }
    if (request.method === 'GET' && id) {
      const doc = store.get(id);
      return doc ? json(200, doc) : googleError(404, `${kind} ${id} not found`);
    }
    if (request.method === 'POST' && !id) {
      const newId = body?.id;
      if (!body || typeof newId !== 'string' || !newId) return googleError(400, 'id is required');
      if (store.has(newId)) return googleError(409, `${kind} ${newId} already exists`);
      if (isObject && !google[CLASS_OF[kind as ObjectResource]].has(String(body.classId)))
        return googleError(404, `Class ${String(body.classId)} not found`);
      store.set(newId, structuredClone(body));
      return json(200, body);
    }
    if (request.method === 'PATCH' && id) {
      const doc = store.get(id);
      if (!doc) return googleError(404, `${kind} ${id} not found`);
      Object.assign(doc, structuredClone(body ?? {}), { id });
      return json(200, doc);
    }
    // PUT replaces the whole resource: fields left out are gone, as on Google.
    if (request.method === 'PUT' && id) {
      if (!store.has(id)) return googleError(404, `${kind} ${id} not found`);
      if (!body || (body.id !== undefined && body.id !== id))
        return googleError(400, 'id mismatch');
      if (isObject && !google[CLASS_OF[kind as ObjectResource]].has(String(body.classId)))
        return googleError(404, `Class ${String(body.classId)} not found`);
      store.set(id, { ...structuredClone(body), id });
      return json(200, store.get(id));
    }
    return googleError(405, 'Method not allowed');
  }

  /** Object `addMessage` (google-messages.md section 1): appends, and the fourth notification in 24 h is refused. */
  function addMessage(
    kind: ObjectResource,
    id: string,
    store: Map<string, Doc>,
    body: Doc | undefined,
  ): Response {
    const doc = store.get(id);
    if (!doc) return googleError(404, `${kind} ${id} not found`);
    const message = (body?.message ?? null) as Doc | null;
    if (!message || typeof message.id !== 'string' || typeof message.body !== 'string')
      return googleError(400, 'message is required');
    const held = Array.isArray(doc.messages) ? (doc.messages as Doc[]) : [];
    if (held.length >= MESSAGE_CAP) return googleError(400, 'Too many messages on the object');
    const key = `${kind}/${id}`;
    if (message.messageType === 'TEXT_AND_NOTIFY') {
      const recent = (notifications.get(key) ?? []).filter((t) => t > now() - NOTIFY_WINDOW_MS);
      if (recent.length >= NOTIFY_LIMIT)
        return json(429, {
          error: {
            code: 429,
            message: 'QuotaExceededException: too many notifying messages in 24 hours',
            status: 'RESOURCE_EXHAUSTED',
          },
        });
      notifications.set(key, [...recent, now()]);
    }
    doc.messages = [...held, structuredClone(message)];
    return json(200, { resource: doc });
  }

  function savePage(jwtText: string): Response {
    const jwt = decodeJwt(jwtText);
    const payload = (jwt?.payload.payload ?? {}) as Record<string, { id?: string }[] | undefined>;
    // The payload key is the object collection pluralised: genericObjects, loyaltyObjects, ...
    const refs = (Object.keys(CLASS_OF) as ObjectResource[]).flatMap((kind) =>
      (payload[`${kind}s`] ?? []).map((o) => ({ kind, id: String(o.id) })),
    );
    if (jwt?.payload.typ !== 'savetowallet' || jwt.payload.aud !== 'google' || !refs.length)
      return googleError(400, 'Invalid save JWT');
    const missing = refs.filter((ref) => !google[ref.kind].has(ref.id));
    if (missing.length) return googleError(404, `Object ${missing[0]?.id} not found`);
    const ids = refs.map((ref) => ref.id);
    saves.push({ objectIds: ids, issuer: String(jwt.payload.iss), typ: jwt.payload.typ });
    return new Response('<!doctype html><title>Saved</title><p>Saved to Google Wallet (mock).', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  function samsungAuthorized(request: Request): boolean {
    return Boolean(bearer(request) && request.headers.get('x-smcs-partner-id'));
  }

  function samsung(request: Request, segments: string[], body: Doc | undefined): Response {
    if (!samsungAuthorized(request)) return json(401, { resultCode: '401' });
    if (segments[0] === 'partner' && segments.slice(1, 4).join('/') === 'v1/card/template') {
      const cardId = segments[4];
      if (request.method !== 'GET' || !cardId) return json(405, { resultCode: '405' });
      const template =
        samsungTemplates.get(cardId) ?? options.defaultSamsungTemplate ?? DEFAULT_TEMPLATE;
      return json(200, { resultCode: '0', template: { cardId, ...template } });
    }
    const [cc2, wltex, cards, cardId, action] = segments;
    if (!(/^[A-Za-z]{2}$/.test(cc2 ?? '') && wltex === 'wltex' && cards === 'cards' && cardId))
      return json(404, { resultCode: '404' });
    if (request.method !== 'POST') return json(405, { resultCode: '405' });
    const card = (body?.card ?? {}) as { type?: string; data?: Doc[] };
    const data = Array.isArray(card.data) ? card.data : [];
    if (action === 'updates') {
      for (const item of data)
        if (typeof item.refId === 'string')
          samsungRefs.set(item.refId, {
            type: String(card.type),
            state: String(item.state),
            cardId,
          });
      return json(200, { resultCode: '0' });
    }
    if (action === 'cancels') {
      for (const item of data) samsungCancels.push({ cardId, eventId: String(item.eventId) });
      return json(200, { resultCode: '0' });
    }
    return json(404, { resultCode: '404' });
  }

  function control(request: Request, segments: string[], body: Doc | undefined): Response {
    const [name] = segments;
    if (name === 'state' && request.method === 'GET')
      return json(200, {
        google: {
          ...Object.fromEntries(RESOURCES.map((name) => [name, Object.fromEntries(google[name])])),
          saves,
        },
        samsung: {
          refs: Object.fromEntries(samsungRefs),
          cancels: samsungCancels,
        },
      });
    if (name === 'requests' && request.method === 'GET') return json(200, requests);
    // The partner portal card a Samsung template read returns (e2e: a loyalty card for storeCard designs).
    if (name === 'samsung-template' && request.method === 'POST') {
      const cardId = body?.cardId;
      if (typeof cardId !== 'string' || !cardId) return json(400, { error: 'cardId is required' });
      const template = { ...DEFAULT_TEMPLATE, ...((body?.template ?? {}) as Doc) };
      samsungTemplates.set(cardId, template as MockSamsungTemplate);
      return json(200, { cardId, ...template });
    }
    // The root keys Google's callback keys endpoint serves (the e2e signs callbacks with their private halves).
    if (name === 'google-keys' && request.method === 'POST') {
      if (!Array.isArray(body?.keys)) return json(400, { error: 'keys must be an array' });
      callbackKeys = body.keys as Doc[];
      return json(200, { keys: callbackKeys.length });
    }
    if (name === 'reset' && request.method === 'POST') {
      reset();
      return json(200, { ok: true });
    }
    if (name === 'inject' && request.method === 'POST') {
      if (typeof body?.match === 'string') {
        try {
          new RegExp(body.match);
        } catch {
          return json(400, { error: 'match is not a valid regular expression' });
        }
      }
      const status = Number(body?.status);
      if (!Number.isInteger(status) || status < 200 || status > 599)
        return json(400, { error: 'status must be an HTTP status' });
      failures.push({
        status,
        match: typeof body?.match === 'string' ? body.match : undefined,
        times: Number(body?.times ?? 1),
        retryAfterSeconds:
          body?.retryAfterSeconds === undefined ? undefined : Number(body.retryAfterSeconds),
        left: Number(body?.times ?? 1),
      });
      return json(200, { rules: failures.length });
    }
    return json(404, { error: 'unknown control endpoint' });
  }

  function takeFailure(label: string): (MockFailure & { left: number }) | undefined {
    const rule = failures.find(
      (f) =>
        f.left > 0 &&
        (f.match === undefined ||
          (typeof f.match === 'string' ? new RegExp(f.match) : f.match).test(label)),
    );
    if (rule) rule.left -= 1;
    failures = failures.filter((f) => f.left > 0);
    return rule;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    let provider: MockProvider = 'samsung';
    if (segments[0] === '__mock') provider = 'control';
    else if (
      url.pathname === '/token' ||
      segments[0] === 'walletobjects' ||
      url.pathname === '/gp/m/issuer/keys' ||
      url.pathname.startsWith('/gp/v/save/')
    )
      provider = 'google';

    let parsed: Doc | undefined;
    let form: URLSearchParams | undefined;
    let logged: unknown;
    if (request.method !== 'GET') {
      if (
        (request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')
      ) {
        form = new URLSearchParams();
        for (const [key, value] of await request.formData()) form.append(key, String(value));
        // The assertion is a signed credential: keep its claims, not the token.
        logged = { grant_type: form.get('grant_type') };
      } else {
        const text = await request.text();
        if (text) {
          try {
            parsed = JSON.parse(text) as Doc;
            logged = parsed;
          } catch {
            return json(400, { error: 'invalid JSON' });
          }
        }
      }
    }

    // The save path embeds a JWT: log the route, not the token.
    const path = url.pathname.startsWith('/gp/v/save/') ? '/gp/v/save/:jwt' : url.pathname;
    const label = `${request.method} ${path}`;
    const entry: MockRequestLog = {
      n: requests.length + 1,
      provider,
      method: request.method,
      path,
      status: 0,
      injected: false,
      ...(logged === undefined ? {} : { body: logged }),
    };
    if (provider !== 'control') requests.push(entry);

    let response: Response;
    const failure = provider === 'control' ? undefined : takeFailure(label);
    if (failure) {
      entry.injected = true;
      response = new Response(
        failure.status === 204 ? null : JSON.stringify({ error: 'injected' }),
        {
          status: failure.status,
          headers: {
            'content-type': 'application/json',
            ...(failure.retryAfterSeconds === undefined
              ? {}
              : { 'retry-after': String(failure.retryAfterSeconds) }),
          },
        },
      );
    } else if (provider === 'control') response = control(request, segments.slice(1), parsed);
    else if (provider === 'google') {
      if (url.pathname === '/token' && request.method === 'POST')
        response = await oauth(form ?? new URLSearchParams());
      else if (url.pathname === '/gp/m/issuer/keys' && request.method === 'GET')
        response = json(200, { keys: callbackKeys });
      else if (url.pathname.startsWith('/gp/v/save/') && request.method === 'GET')
        response = savePage(decodeURIComponent(url.pathname.slice('/gp/v/save/'.length)));
      else if (segments[0] === 'walletobjects' && segments[1] === 'v1')
        response = await walletObjects(request, segments.slice(2), parsed);
      else response = googleError(404, 'Not found');
    } else response = samsung(request, segments, parsed);
    entry.status = response.status;
    return response;
  }

  return {
    handle,
    reset,
    /** Fails the next `times` matching provider requests; see `MockFailure`. */
    failNext(failure: MockFailure): void {
      const times = failure.times ?? 1;
      failures.push({ ...failure, times, left: times });
    },
    setSamsungTemplate(cardId: string, template: MockSamsungTemplate): void {
      samsungTemplates.set(cardId, template);
    },
    get requests(): readonly MockRequestLog[] {
      return requests;
    },
    /** Notifying messages the mock accepted per `collection/id` with their times (what Google counts). */
    get notifications(): ReadonlyMap<string, readonly number[]> {
      return notifications;
    },
    /** Counts notifications Google saw that PassBook did not send, so the quota refusal can be exercised. */
    seedNotifications(kind: ObjectResource, id: string, count: number): void {
      const key = `${kind}/${id}`;
      notifications.set(key, [...(notifications.get(key) ?? []), ...Array(count).fill(now())]);
    },
    google,
    saves,
    samsungRefs,
    samsungCancels,
  };
}
