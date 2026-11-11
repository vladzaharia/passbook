import { keepPreviousData } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { z } from 'zod';
import { STATE_COPY } from '@/shared/copy/states.ts';
import { ApiError, problemToError } from './errors.ts';
import { modeHeaders } from './mode.ts';
import { safeNext } from './redirect.ts';

export type QueryValue = string | number | boolean | null | undefined;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Sent as If-Match for optimistic concurrency. */
  ifMatch?: string;
}

export interface ApiClientDeps {
  fetch?: typeof fetch;
  /** CSRF token for writes; undefined when there is no session. */
  getCsrfToken: () => Promise<string | undefined>;
  /** Current authenticated principal, or undefined when the session is not known. */
  getSessionPrincipal?: () => string | undefined;
  /** Called on a current-principal 401, or any 401 when no principal getter is supplied. */
  onUnauthorized?: (error: ApiError) => void;
}

const WRITE = new Set<Method>(['POST', 'PUT', 'PATCH', 'DELETE']);

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON error bodies (proxies, HTML) map to a generic ApiError by status.
    return undefined;
  }
}

export function createApiClient(deps: ApiClientDeps) {
  async function send(
    method: Method,
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<unknown> {
    // Capture before awaiting CSRF: a write can outlive a principal change even before fetch.
    const getSessionPrincipal = deps.getSessionPrincipal;
    const principal = getSessionPrincipal?.();
    const isWrite = WRITE.has(method);
    const doFetch = deps.fetch ?? fetch;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...modeHeaders(),
      ...opts.headers,
    };
    if (isWrite) {
      const token = await deps.getCsrfToken();
      if (token) headers['x-csrf-token'] = token;
    }
    if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
    let payload: BodyInit | undefined;
    if (body instanceof FormData || body instanceof Blob) {
      payload = body;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (isWrite && principal !== undefined && getSessionPrincipal?.() !== principal) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      throw new ApiError({
        status: 409,
        code: 'session_changed',
        detail: 'The signed-in account changed. Review your changes and try again.',
      });
    }
    // A write may discover its first known session while looking up CSRF.
    const requestPrincipal =
      isWrite && principal === undefined ? getSessionPrincipal?.() : principal;
    let res: Response;
    try {
      res = await doFetch(buildUrl(path, opts.query), {
        method,
        headers,
        body: payload,
        credentials: 'same-origin',
        signal: opts.signal,
      });
    } catch (cause) {
      if (opts.signal?.aborted) throw cause;
      throw new ApiError({
        status: 0,
        code: 'network',
        detail: STATE_COPY.network,
      });
    }
    const data = await readBody(res);
    if (!res.ok) {
      const error = problemToError(res.status, data);
      if (
        res.status === 401 &&
        (!getSessionPrincipal ||
          (requestPrincipal !== undefined && requestPrincipal === getSessionPrincipal()))
      ) {
        deps.onUnauthorized?.(error);
      }
      throw error;
    }
    return data;
  }

  function parse<S extends z.ZodType>(schema: S, data: unknown, path: string): z.infer<S> {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new ApiError({
        status: 502,
        code: 'invalid_response',
        detail: `Unexpected response from ${path.split('?')[0]}.`,
      });
    }
    return result.data;
  }

  return {
    async get<S extends z.ZodType>(
      path: string,
      schema: S,
      opts: RequestOptions = {},
    ): Promise<z.infer<S>> {
      return parse(schema, await send('GET', path, undefined, opts), path);
    },
    async post<S extends z.ZodType>(
      path: string,
      schema: S,
      body?: unknown,
      opts: RequestOptions = {},
    ): Promise<z.infer<S>> {
      return parse(schema, await send('POST', path, body, opts), path);
    },
    async put<S extends z.ZodType>(
      path: string,
      schema: S,
      body?: unknown,
      opts: RequestOptions = {},
    ): Promise<z.infer<S>> {
      return parse(schema, await send('PUT', path, body, opts), path);
    },
    async patch<S extends z.ZodType>(
      path: string,
      schema: S,
      body?: unknown,
      opts: RequestOptions = {},
    ): Promise<z.infer<S>> {
      return parse(schema, await send('PATCH', path, body, opts), path);
    },
    /** DELETE that returns a body. */
    async deleteJson<S extends z.ZodType>(
      path: string,
      schema: S,
      opts: RequestOptions = {},
    ): Promise<z.infer<S>> {
      return parse(schema, await send('DELETE', path, undefined, opts), path);
    },
    /** For endpoints that return no body. */
    async delete(path: string, opts: RequestOptions = {}): Promise<void> {
      await send('DELETE', path, undefined, opts);
    },
    /** Write that returns no body. */
    async action(
      method: Exclude<Method, 'GET'>,
      path: string,
      body?: unknown,
      opts: RequestOptions = {},
    ): Promise<void> {
      await send(method, path, body, opts);
    },
  };
}

let csrfProvider: () => Promise<string | undefined> = async () => undefined;

/** Wired once at startup (lib/query-client.ts) so api.ts does not import the session. */
export function setCsrfProvider(fn: () => Promise<string | undefined>): void {
  csrfProvider = fn;
}

let sessionPrincipalProvider: () => string | undefined = () => undefined;

/** Wired once at startup, like the CSRF provider, without importing the session. */
export function setSessionPrincipalProvider(fn: () => string | undefined): void {
  sessionPrincipalProvider = fn;
}

// A 401 means the session ended mid-use. However many requests come back 401, one dialog says so
// (ui/session-ended-dialog.tsx); its button signs in again and returns here.
let sessionEnded = false;
const sessionListeners = new Set<() => void>();

export function endSession(): void {
  if (typeof window === 'undefined' || window.location.pathname === '/login') return;
  if (sessionEnded) return;
  sessionEnded = true;
  for (const listener of sessionListeners) listener();
}

/** Clear the old session's notification after a principal switch. */
export function resetSessionEnded(): void {
  if (!sessionEnded) return;
  sessionEnded = false;
  for (const listener of sessionListeners) listener();
}

function subscribeSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** True once a request came back 401. */
export function useSessionEnded(): boolean {
  return useSyncExternalStore(
    subscribeSession,
    () => sessionEnded,
    () => false,
  );
}

/**
 * Sign-in that returns to `next` and says why the session went. Home is no destination, as in the
 * session guard: signing in picks it.
 */
export function sessionEndedHref(next: string): string {
  const target = safeNext(next);
  return target === '/'
    ? '/login?reason=expired'
    : `/login?next=${encodeURIComponent(target)}&reason=expired`;
}

export const api = createApiClient({
  getCsrfToken: () => csrfProvider(),
  getSessionPrincipal: () => sessionPrincipalProvider(),
  onUnauthorized: endSession,
});

/**
 * Options for a list query: a key change (filter, search, page) keeps the previous rows on screen
 * while the next ones load (DataTable dims them and runs the loading rail).
 */
export function listQuery<O extends object>(
  options: O,
): O & { placeholderData: typeof keepPreviousData } {
  return { ...options, placeholderData: keepPreviousData };
}
