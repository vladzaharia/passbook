import type { ConnectorContext, UpstreamRecord } from '../types.ts';
import { type Config, config } from './config.ts';
import connector from './index.ts';

export type Cfg = Config;

export function demoCtx(raw: Record<string, unknown> = {}): ConnectorContext<Cfg, undefined> {
  return {
    connection: { id: 'c', orgId: 'o', generation: 1, config: config.parse(raw) },
    secrets: undefined,
    now: () => 0,
    fetch: async () => {
      throw new Error('demo must not fetch');
    },
    signal: new AbortController().signal,
    log: () => {},
  };
}

/** Every record the listing returns, in order. */
export async function listRecords(raw: Record<string, unknown>): Promise<UpstreamRecord[]> {
  const ctx = demoCtx(raw);
  const out: UpstreamRecord[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const page: Awaited<ReturnType<NonNullable<typeof connector.listChanges>>> | undefined =
      await connector.listChanges?.(ctx, cursor);
    if (!page) throw new Error('no listChanges');
    for (const c of page.changes) if (c.record) out.push(c.record);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  return out;
}

export const str = (r: UpstreamRecord, k: string) => String(r[k]);
export const ms = (r: UpstreamRecord, k: string) => Date.parse(str(r, k));
