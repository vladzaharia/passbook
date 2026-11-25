import { apiErrorFrom, ConnectionError, PassBookError } from './errors.ts';
import { API_VERSION } from './generated/api-version.ts';
import { type PageLike, type PagePromise, pagePromise } from './pagination.ts';
import { backoffMs, MAX_RETRY_AFTER_MS, retryAfterMs, sleep } from './retry.ts';
import { SDK_VERSION } from './version.ts';

export type { PagePromise } from './pagination.ts';

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<string | number | boolean>;

export interface RequestOptions<Query = Record<string, QueryValue>> {
  /** Sent as `Idempotency-Key` on operations that accept one. Default: a fresh UUID per call, reused across retries. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
  /** Overrides the client's `maxRetries`. */
  maxRetries?: number;
  /** Overrides the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Query parameters, for operations whose first argument is a body. */
  query?: Query;
}

export interface PassBookOptions {
  /** A `pbp_live_` or `pbp_test_` key (`pb_` and `pbo_` keys work too). A test key only ever sees test data. */
  apiKey: string;
  /** Default `https://passbook.mobile`. */
  baseUrl?: string;
  /** Default: the global `fetch`. Pass your own for a proxy, a test double or a service binding. */
  fetch?: typeof fetch;
  /** Retries after the first attempt on 429, 5xx and network errors. Default 2. */
  maxRetries?: number;
  /** Per attempt. Default 60 000. */
  timeoutMs?: number;
  /** First backoff step. Default 500. */
  retryDelayMs?: number;
  /** Sent as `PassBook-Version`. Default: the newest version this SDK was generated against. */
  apiVersion?: string;
  /** Sent as `User-Agent`. Default `passbook-sdk-js/<version>`. */
  userAgent?: string;
}

/** One call, as the generated resources describe it. */
export interface OperationSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: object;
  body?: unknown;
  /** Accepts `Idempotency-Key`. */
  idempotent?: boolean;
  /** Return the `Response` itself, for downloads. */
  raw?: boolean;
  /** `body` is binary, sent as is with this content type. */
  contentType?: string;
}

/** Safe to repeat after a lost response (RFC 9110); POST and PATCH are, only with an idempotency key. */
const REPEATABLE = new Set(['GET', 'PUT', 'DELETE']);

function queryString(...parts: Array<object | undefined>): string {
  const out = new URLSearchParams();
  for (const part of parts) {
    for (const [name, value] of Object.entries(part ?? {}) as Array<[string, QueryValue]>) {
      if (value === undefined || value === null) continue;
      for (const v of Array.isArray(value) ? value : [value]) out.append(name, String(v));
    }
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

const jsonBody = (body: unknown): string | undefined =>
  body === undefined ? undefined : JSON.stringify(body);

export class Core {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly apiVersion: string;
  private readonly userAgent: string;

  constructor(options: PassBookOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '')
      throw new PassBookError('apiKey is required: pass a pbp_live_ or pbp_test_ key.');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://passbook.mobile').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.apiVersion = options.apiVersion ?? API_VERSION;
    this.userAgent = options.userAgent ?? `passbook-sdk-js/${SDK_VERSION}`;
  }

  /** One attempt, bounded by the per-attempt timeout and the caller's signal. */
  private async attempt(
    url: string,
    init: RequestInit,
    options: Pick<RequestOptions, 'signal' | 'timeoutMs'>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('The request timed out.')),
      options.timeoutMs ?? this.timeoutMs,
    );
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async request<T>(spec: OperationSpec, options: RequestOptions<object> = {}): Promise<T> {
    const url = `${this.baseUrl}${spec.path}${queryString(spec.query, options.query)}`;
    const headers = new Headers({
      accept: 'application/json',
      'user-agent': this.userAgent,
      'passbook-version': this.apiVersion,
    });
    // `set`, not the constructor: header names are case-insensitive, so a per-call header replaces a default.
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    headers.set('authorization', `Bearer ${this.apiKey}`);
    const body = spec.contentType ? (spec.body as BodyInit) : jsonBody(spec.body);
    if (body !== undefined) headers.set('content-type', spec.contentType ?? 'application/json');
    const key = spec.idempotent ? (options.idempotencyKey ?? crypto.randomUUID()) : undefined;
    if (key) headers.set('idempotency-key', key);
    const repeatable = REPEATABLE.has(spec.method) || key !== undefined;
    const maxRetries = options.maxRetries ?? this.maxRetries;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.attempt(url, { method: spec.method, headers, body }, options);
      } catch (cause) {
        if (options.signal?.aborted) throw cause;
        if (!repeatable || attempt >= maxRetries)
          throw new ConnectionError(`Could not reach PassBook: ${String(cause)}`, { cause });
        await sleep(backoffMs(attempt, this.retryDelayMs), options.signal);
        continue;
      }
      if (res.ok) return this.parse<T>(res, spec);
      const error = await apiErrorFrom(res);
      // A 429 was refused before it ran, so any call may repeat; a 5xx may have run.
      const retryable = res.status === 429 || (res.status >= 500 && repeatable);
      const asked = retryAfterMs(res.headers.get('retry-after'));
      if (!retryable || attempt >= maxRetries || (asked !== null && asked > MAX_RETRY_AFTER_MS))
        throw error;
      await sleep(asked ?? backoffMs(attempt, this.retryDelayMs), options.signal);
    }
  }

  private async parse<T>(res: Response, spec: OperationSpec): Promise<T> {
    if (spec.raw) return res as T;
    const text = res.status === 204 ? '' : await res.text();
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new PassBookError('The response was not valid JSON.', { cause });
    }
  }

  /** A list: the first page as a promise, every item as an async iterator. */
  paginate<P extends PageLike>(
    spec: OperationSpec,
    cursorParam: string,
    options: RequestOptions<object> = {},
  ): PagePromise<P> {
    const query = (spec.query ?? {}) as Record<string, QueryValue>;
    const start = query[cursorParam];
    return pagePromise<P>(
      (cursor) =>
        this.request<P>(
          { ...spec, query: cursor === undefined ? query : { ...query, [cursorParam]: cursor } },
          options,
        ),
      typeof start === 'string' ? start : undefined,
    );
  }
}
