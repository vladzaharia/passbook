import { type ReactNode, useMemo } from 'react';
import { vi } from 'vitest';
import type { RequestLogDetail, RequestLogEntry } from '../../../shared/contracts/developer.ts';
import { ToolScopeProvider } from '../../lib/tool-api.tsx';
import { resetBenchZone } from '../bench/zone.ts';
import { createToolApi } from '../host/api.ts';
import { forgetDetails } from './use-detail.ts';

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const entry = (n: number, over: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  id: `log-${n}`,
  requestId: `req-${n}`,
  at: Date.UTC(2026, 10, 25, 22, 15, 53) - n * 1000,
  method: 'POST',
  route: '/api/v1/passes/:id',
  path: '/api/v1/passes/p1',
  query: 'a=1',
  status: 201,
  code: null,
  durationMs: 12,
  keyId: 'key-12345678-xyz',
  mode: 'test',
  via: null,
  client: 'curl/8.7.1',
  hasBodies: true,
  resourceId: null,
  apiVersion: null,
  flags: { idempotencyKey: false, ifMatch: false, version: false },
  ...over,
});

export const detail = (n: number, over: Partial<RequestLogDetail> = {}): RequestLogDetail => ({
  ...entry(n),
  requestBody: '{"name":"Ada"}',
  responseBody: '{"id":"p1","ok":true}',
  bodiesExpireAt: Date.now() + 3_600_000,
  bodiesRecorded: true,
  bodiesTruncated: false,
  ...over,
});

export const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
  json({ items, nextCursor: null, capped: null, bodiesRecorded: true, ...extra });

/** The org's Test keys, as `GET /api-keys` lists them. */
export const keyRows = [
  {
    id: 'key-12345678-xyz',
    name: 'Sandbox key',
    prefix: 'pb_test_ab12',
    mode: 'test',
    revokedAt: null,
  },
  { id: 'key-live', name: 'Live key', prefix: 'pb_live_cd34', mode: 'live', revokedAt: null },
];

/** A fetch that answers by path: the log lists in order, one row by id, the keys, the operation index. */
export function stubApi(opts: {
  lists: Response[];
  rows?: Record<string, RequestLogDetail>;
  status?: number;
  keys?: unknown[];
}) {
  const calls: string[] = [];
  const auths: (string | null)[] = [];
  const lists = [...opts.lists];
  vi.stubGlobal('reportError', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      auths.push(new Headers(init?.headers).get('authorization'));
      if (url.includes('/api/v1/api-keys')) return json({ items: opts.keys ?? keyRows });
      if (url.includes('/webhook-endpoints?'))
        return json({ items: [{ id: 'ep-1', target: 'capture' }] });
      if (url.includes('/captures?requestId='))
        return json({ items: [{ eventId: 'evt-1', type: 'pass.issued', status: 200 }] });
      if (url.includes('logs-ops')) return json({ 'POST /api/v1/passes/{id}': 'passes.update' });
      const one = /\/request-logs\/([^?]+)/.exec(url);
      if (one) {
        const row = opts.rows?.[decodeURIComponent(one[1] as string)];
        return row ? json(row) : json({ code: 'NOT_FOUND' }, 404);
      }
      if (url.includes('/api/v1/request-logs')) {
        if (opts.status) return json({ code: 'BOOM' }, opts.status);
        return (lists.length > 1 ? lists.shift() : lists[0])?.clone() ?? json({}, 500);
      }
      return json({}, 404);
    }),
  );
  return Object.assign(calls, { auths });
}

/** The Workbench's token client, pinned the way the host pins it: every call carries the bearer. */
export function Scoped({ children }: { children: ReactNode }) {
  const api = useMemo(
    () => createToolApi({ orgId: 'nw', token: async () => 'pbtry_nw', drop: () => undefined }),
    [],
  );
  return (
    <ToolScopeProvider api={api} client="workbench:nw" mode="test" orgId="nw">
      {children}
    </ToolScopeProvider>
  );
}

/** The page as a visitor in a wide window: the pane is beside the list, and a close is immediate. */
export function wideWindow() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('1180') || q.includes('720') || q.includes('reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

export function reset() {
  forgetDetails();
  resetBenchZone();
  history.replaceState(null, '', '/workbench/o/nw/logs');
}
