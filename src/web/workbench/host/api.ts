import { z } from 'zod';
import { STATE_COPY } from '@/shared/copy/states.ts';
import { ApiError } from '../../lib/errors.ts';
import { readJson } from './session-fetch.ts';

type Query = Record<string, string | number | boolean | null | undefined>;

export interface ToolRequest {
  query?: Query;
  signal?: AbortSignal;
  /** Gives up after this long with a `timeout` ApiError. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  ifMatch?: string;
}

/** Marks a background read as the portal's own: the request log keeps it out of the Calls a developer reads. */
export const PORTAL_READ = { 'x-passbook-client': 'portal' } as const;

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Every tenant call from a Workbench page (design §2.3, L13): a bearer Workbench token, the
 * session cookie the server binds that token to (`same-origin`), and no mode header (the token is
 * Test). A refused token is never answered with a cookie-only call.
 * Its methods are the session client's, so it fits `lib/tool-api.tsx`'s `ToolApi` (DC1's tool
 * scope) and a shared tool runs on it unchanged.
 */
export interface WorkbenchApi {
  readonly orgId: string;
  get<S extends z.ZodType>(path: string, schema: S, opts?: ToolRequest): Promise<z.infer<S>>;
  post<S extends z.ZodType>(
    path: string,
    schema: S,
    body?: unknown,
    opts?: ToolRequest,
  ): Promise<z.infer<S>>;
  put<S extends z.ZodType>(
    path: string,
    schema: S,
    body?: unknown,
    opts?: ToolRequest,
  ): Promise<z.infer<S>>;
  patch<S extends z.ZodType>(
    path: string,
    schema: S,
    body?: unknown,
    opts?: ToolRequest,
  ): Promise<z.infer<S>>;
  deleteJson<S extends z.ZodType>(path: string, schema: S, opts?: ToolRequest): Promise<z.infer<S>>;
  delete(path: string, opts?: ToolRequest): Promise<void>;
  action(method: Method, path: string, body?: unknown, opts?: ToolRequest): Promise<void>;
}

export interface ToolApiDeps {
  orgId: string;
  /** The org's current token (token.ts). */
  token: () => Promise<string>;
  /** Forget a refused token (the one that was sent, so a newer one stays). */
  drop: (used?: string) => void;
  /** The session behind the token is gone: the mint itself was refused. */
  onSessionGone?: () => void;
  fetch?: typeof fetch;
}

/** A caller's mode header is dropped: the token's Test is the only mode. */
const MODE_HEADER = /^x-passbook-mode$/i;

export function buildQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

/**
 * `fetch` with the org's Workbench token: any case of the mode header stripped, `authorization`
 * set last, the cookie sent only because the server binds the token to it. A 401 drops the token
 * and mints once more; then the answer stands. A token that cannot be had throws: there is no
 * cookie-only attempt.
 */
export function createBearerFetch(
  deps: ToolApiDeps,
): (url: string, init?: RequestInit) => Promise<Response> {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));

  async function bearer(): Promise<string> {
    try {
      return await deps.token();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) deps.onSessionGone?.();
      throw error;
    }
  }

  const attempt = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    for (const key of [...headers.keys()]) if (MODE_HEADER.test(key)) headers.delete(key);
    const token = await bearer();
    headers.set('authorization', `Bearer ${token}`);
    const res = await doFetch(url, {
      ...init,
      headers: Object.fromEntries(headers.entries()),
      credentials: 'same-origin',
    });
    return { res, token };
  };
  return async (url, init = {}) => {
    let sent = await attempt(url, init);
    // An expired or revoked token: mint once more, then let the error stand.
    if (sent.res.status === 401) {
      deps.drop(sent.token);
      sent = await attempt(url, init);
    }
    return sent.res;
  };
}

export function createToolApi(deps: ToolApiDeps): WorkbenchApi {
  const bearerFetch = createBearerFetch(deps);

  async function send(method: string, path: string, body: unknown, opts: ToolRequest = {}) {
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [key, value] of Object.entries(opts.headers ?? {}))
      if (!MODE_HEADER.test(key)) headers[key.toLowerCase()] = value;
    if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const url = buildQuery(path, opts.query);
    const timeout = opts.timeoutMs === undefined ? undefined : AbortSignal.timeout(opts.timeoutMs);
    const signal =
      timeout && opts.signal ? AbortSignal.any([opts.signal, timeout]) : (timeout ?? opts.signal);
    try {
      return await bearerFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (opts.signal?.aborted || cause instanceof ApiError) throw cause;
      if (timeout?.aborted)
        throw new ApiError({ status: 0, code: 'timeout', detail: STATE_COPY.timeout });
      throw new ApiError({ status: 0, code: 'network', detail: STATE_COPY.network });
    }
  }

  const json =
    (method: string) =>
    async <S extends z.ZodType>(path: string, schema: S, body?: unknown, opts?: ToolRequest) =>
      readJson(await send(method, path, body, opts), schema, path);

  return {
    orgId: deps.orgId,
    get: (path, schema, opts) => json('GET')(path, schema, undefined, opts),
    post: json('POST'),
    put: json('PUT'),
    patch: json('PATCH'),
    deleteJson: (path, schema, opts) => json('DELETE')(path, schema, undefined, opts),
    async delete(path, opts) {
      await readJson(await send('DELETE', path, undefined, opts), z.unknown(), path);
    },
    async action(method, path, body, opts) {
      await readJson(await send(method, path, body, opts), z.unknown(), path);
    },
  };
}
