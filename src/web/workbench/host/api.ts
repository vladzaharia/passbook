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

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Every tenant call from a Workbench page (design §2.3, L13): a bearer Workbench token,
 * `credentials: 'omit'` so no session cookie rides along, and no mode header (the token is Test).
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
  /** Forget a refused token. */
  drop: () => void;
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

export function createToolApi(deps: ToolApiDeps): WorkbenchApi {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));

  async function bearer(): Promise<string> {
    try {
      return await deps.token();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) deps.onSessionGone?.();
      throw error;
    }
  }

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
    const attempt = async () => {
      try {
        return await doFetch(url, {
          method,
          headers: { ...headers, authorization: `Bearer ${await bearer()}` },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'omit',
          signal,
        });
      } catch (cause) {
        if (opts.signal?.aborted || cause instanceof ApiError) throw cause;
        if (timeout?.aborted)
          throw new ApiError({ status: 0, code: 'timeout', detail: STATE_COPY.timeout });
        throw new ApiError({ status: 0, code: 'network', detail: STATE_COPY.network });
      }
    };
    let res = await attempt();
    // An expired or revoked token: mint once more, then let the error stand.
    if (res.status === 401) {
      deps.drop();
      res = await attempt();
    }
    return res;
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
