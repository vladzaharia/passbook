import type { SafeFetch, SafeResponse } from '../../platform/safe-fetch.ts';
import { egressFetch } from '../lib/egress.ts';
import type { ConnectorContext } from '../types.ts';
import connector from './index.ts';

export type Cfg = ReturnType<typeof connector.configSchema.parse>;
export type Sec = NonNullable<ReturnType<NonNullable<typeof connector.secretSchema>['parse']>>;

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  throws?: Error;
}

export const NOW = Date.UTC(2026, 0, 1);

/** A context over a scripted fetch, pinned to the base origin the way the runtime pins it. */
export function harness(
  config: Record<string, unknown>,
  secrets: Sec = {},
  reply: (url: URL, init: RequestInit) => Reply = () => ({ body: {} }),
  webhookSecret?: string,
  options: { now?: () => number; signal?: AbortSignal } = {},
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const logs: string[] = [];
  const raw: SafeFetch = async (url, init) => {
    const r = reply(new URL(url), init ?? {});
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (r.throws) throw r.throws;
    const text = JSON.stringify(r.body ?? {});
    const bytes = new TextEncoder().encode(typeof r.body === 'string' ? r.body : text);
    return {
      status: r.status ?? 200,
      headers: new Headers(r.headers),
      body: bytes,
      text: () => new TextDecoder().decode(bytes),
      json: <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    } satisfies SafeResponse;
  };
  const parsed = connector.configSchema.parse(config) as Cfg;
  const ctx: ConnectorContext<Cfg, Sec> = {
    connection: { id: 'c1', orgId: 'o1', generation: 1, config: parsed },
    secrets,
    ...(webhookSecret ? { webhookSecret } : {}),
    now: options.now ?? (() => NOW),
    fetch: egressFetch(connector, parsed, raw),
    signal: options.signal ?? new AbortController().signal,
    log: (event) => {
      logs.push(event);
    },
  };
  return { ctx, calls, logs };
}

/** Pages through listChanges until it stops, as the sync does; returns every ref and the last cursor. */
export async function drain(ctx: ConnectorContext<Cfg, Sec>, from: string | null = null) {
  const refs: string[] = [];
  let cursor = from;
  let pages = 0;
  for (; pages < 50; pages++) {
    const res = await connector.listChanges?.(ctx, cursor);
    if (!res) throw new Error('no listChanges');
    refs.push(...res.changes.map((c) => c.ref));
    cursor = res.cursor;
    if (!res.hasMore) return { refs, cursor, pages: pages + 1 };
  }
  throw new Error('did not stop');
}
