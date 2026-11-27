import { createContext, createElement, type ReactNode, useContext } from 'react';
import type { Operation } from './types.ts';

export class OperationsHttpError extends Error {
  readonly status: number;
  /** From Retry-After, when the server sent one. */
  readonly retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`Operations request failed (${status}).`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface OperationFilter {
  active?: boolean;
  mine?: boolean;
  target?: { type: string; id: string };
  /** One kind (`org.export`), and the org whose operations to read: an org's rows are not the person's own. */
  kind?: string;
  orgId?: string;
}

/** What the kit needs from the server; the app, the portal and the developer site each supply one. */
export interface OperationsClient {
  /** `operation` is null on 304: unchanged since `etag`. */
  get(
    id: string,
    opts: { etag?: string | null; signal?: AbortSignal },
  ): Promise<{ operation: Operation | null; etag: string | null }>;
  list(filter: OperationFilter, signal?: AbortSignal): Promise<readonly Operation[]>;
  cancel(id: string): Promise<Operation>;
  retry(id: string): Promise<Operation>;
}

export interface FetchClientOptions {
  fetch?: typeof fetch;
  /** The write token for POST; none when there is no session. */
  csrf?: () => Promise<string | undefined>;
  /** Extra headers on every request (the Test mode header). */
  headers?: () => Record<string, string>;
  base?: string;
}

/** The kit's default client over `fetch` (ETag, 304, Retry-After): no router, no query cache. */
export function createFetchClient({
  fetch: doFetch = (...args) => fetch(...args),
  csrf,
  headers,
  base = '/api/v1/operations',
}: FetchClientOptions = {}): OperationsClient {
  async function send(
    method: 'GET' | 'POST',
    path: string,
    init: RequestInit = {},
    etag?: string | null,
  ) {
    const h: Record<string, string> = { accept: 'application/json', ...headers?.() };
    if (etag) h['if-none-match'] = etag;
    if (method === 'POST') {
      const token = await csrf?.();
      if (token) h['x-csrf-token'] = token;
      h['idempotency-key'] = crypto.randomUUID();
    }
    const res = await doFetch(`${base}${path}`, {
      ...init,
      method,
      headers: h,
      credentials: 'same-origin',
    });
    if (res.status === 304) return { res, body: null };
    if (!res.ok) {
      const wait = Number(res.headers.get('retry-after'));
      throw new OperationsHttpError(res.status, wait > 0 ? wait * 1000 : null);
    }
    return { res, body: (await res.json()) as unknown };
  }
  return {
    async get(id, { etag, signal }) {
      const { res, body } = await send('GET', `/${encodeURIComponent(id)}`, { signal }, etag);
      return { operation: body as Operation | null, etag: res.headers.get('etag') ?? etag ?? null };
    },
    async list(filter, signal) {
      const q = new URLSearchParams();
      if (filter.active) q.set('active', 'true');
      if (filter.mine) q.set('mine', 'true');
      if (filter.target) q.set('target', `${filter.target.type}:${filter.target.id}`);
      if (filter.kind) q.set('kind', filter.kind);
      if (filter.orgId) q.set('orgId', filter.orgId);
      const qs = q.toString();
      const { body } = await send('GET', qs ? `?${qs}` : '', { signal });
      return ((body as { items?: Operation[] } | null)?.items ?? []) as Operation[];
    },
    async cancel(id) {
      const { body } = await send('POST', `/${encodeURIComponent(id)}/cancel`);
      return body as Operation;
    },
    async retry(id) {
      const { body } = await send('POST', `/${encodeURIComponent(id)}/retry`);
      return body as Operation;
    },
  };
}

const Context = createContext<OperationsClient | null>(null);
let fallback: OperationsClient | undefined;

export function OperationsProvider({
  client,
  children,
}: {
  client: OperationsClient;
  children: ReactNode;
}) {
  return createElement(Context.Provider, { value: client }, children);
}

export function useOperationsClient(): OperationsClient {
  const given = useContext(Context);
  if (given) return given;
  fallback ??= createFetchClient();
  return fallback;
}
