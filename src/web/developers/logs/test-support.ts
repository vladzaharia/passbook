import { vi } from 'vitest';
import type {
  ApiRail,
  RequestLogDetail,
  RequestLogEntry,
} from '../../../shared/contracts/developer.ts';
import { forgetRail } from '../bench/rail.ts';
import { resetBenchZone } from '../bench/zone.ts';
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
  ...over,
});

export const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
  json({ items, nextCursor: null, capped: null, ...extra });

export const rail: ApiRail = {
  mode: 'test',
  scopes: ['passes:read', 'passes:write'],
  tier: 'standard',
  limitPerMinute: 1200,
  callsLastHour: 3456,
  series: [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1],
  key: { id: 'key-12345678-xyz', name: 'Sandbox key', prefix: 'pb_test_ab12' },
};

/** A fetch that answers by path: the log lists in order, one row by id, the rail, the operation index. */
export function stubApi(opts: {
  lists: Response[];
  rows?: Record<string, RequestLogDetail>;
  status?: number;
}) {
  const calls: string[] = [];
  const lists = [...opts.lists];
  vi.stubGlobal('reportError', vi.fn());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/developer/rail')) return json(rail);
      if (url.includes('/webhook-endpoints?'))
        return json({ items: [{ id: 'ep-1', target: 'capture' }] });
      if (url.includes('/captures?requestId='))
        return json({ items: [{ eventId: 'evt-1', type: 'pass.issued', status: 200 }] });
      if (url.includes('/developer/session') || url.endsWith('/api/v1/session'))
        return json({ authenticated: false });
      if (url.includes('logs-ops')) return json({ 'POST /api/v1/passes/{id}': 'passes.update' });
      const one = /\/developer\/logs\/([^?]+)/.exec(url);
      if (one) {
        const row = opts.rows?.[decodeURIComponent(one[1] as string)];
        return row ? json(row) : json({ code: 'NOT_FOUND' }, 404);
      }
      if (url.includes('/developer/logs')) {
        if (opts.status) return json({}, opts.status);
        return (lists.length > 1 ? lists.shift() : lists[0])?.clone() ?? json({}, 500);
      }
      return json({}, 404);
    }),
  );
  return calls;
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
  forgetRail();
  forgetDetails();
  resetBenchZone();
  history.replaceState(null, '', '/developers/logs');
}
