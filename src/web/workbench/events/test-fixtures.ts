import { vi } from 'vitest';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { detail, endpoint, NOW } from '../../admin/connections/webhooks/test-fixtures.ts';
import { type FetchHandler, json } from '../../lib/test-utils.tsx';
import { handlers as shell } from '../shell/test-fixtures.ts';

export const CAPTURE = endpoint({
  id: 'wecap',
  orgId: 'sbx',
  mode: 'test',
  target: 'capture',
  url: 'https://capture.invalid/',
  urlMasked: 'capture.invalid',
  description: '',
  eventTypes: ['pass.issued', 'pass.scanned'],
});
export const HOOK = endpoint({
  id: 'we1',
  orgId: 'sbx',
  mode: 'test',
  url: 'https://hooks.example.com/passbook/abcd1234',
});

/** A feed event: the ledger's envelope. */
export const feedEvent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'pass.scanned',
  apiVersion: '2026-11-20',
  createdAt: NOW - 3_600_000,
  orgId: 'sbx',
  mode: 'test',
  pass: { id: 'p1234567890', externalId: 'ORD-7', templateId: 't1' },
  data: { outcome: 'ok' },
  ...over,
});

export const capture = (id: string, eventId: string, over: Record<string, unknown> = {}) => ({
  id,
  endpointId: CAPTURE.id,
  eventId,
  type: 'pass.scanned',
  trigger: 'event',
  status: 200,
  durationMs: 4,
  headers: { 'x-passbook-event-id': eventId, 'content-type': 'application/json' },
  body: JSON.stringify(feedEvent(eventId)),
  createdAt: NOW - 3_600_000,
  ...over,
});

export interface Calls {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface World {
  endpoints: WebhookEndpointDto[];
  events: ReturnType<typeof feedEvent>[];
  /** Per event: its deliveries across endpoints. */
  deliveries: Record<string, unknown[]>;
  captures: ReturnType<typeof capture>[];
  summary?: Record<string, unknown>;
}

const keep = (calls: Calls[], url: URL, init?: RequestInit) =>
  calls.push({
    method: (init?.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    search: url.search,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });

/** The routes the Events tool calls, every request recorded. */
export function eventsHandlers(world: World, calls: Calls[]): Record<string, FetchHandler> {
  const at = (path: string, fn: FetchHandler): [string, FetchHandler] => [
    path,
    (url, init) => {
      keep(calls, url, init);
      return fn(url, init);
    },
  ];
  const routes: [string, FetchHandler][] = [
    at('/api/v1/events', (url) => {
      const after = url.searchParams.get('after');
      return json({
        items: after ? [] : world.events,
        nextCursor: after ?? 'ev2.AAAAAAAAAAAAAAAAAAAAAA',
        hasMore: false,
      });
    }),
    at('/api/v1/webhook-endpoints', (url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        if (url.searchParams.get('validate')) return json({ ok: true });
        const body = JSON.parse(String(init?.body)) as { url: string };
        const made = endpoint({ id: 'we-new', orgId: 'sbx', mode: 'test', url: body.url });
        world.endpoints.push(made);
        return json({ endpoint: made, secret: 'whsec_shown_once' }, 201);
      }
      return json({ items: world.endpoints, nextCursor: null });
    }),
    at('/api/v1/webhook-endpoints/capture', () => json({ endpoint: CAPTURE, secret: null })),
    at('/api/v1/webhook-endpoints/wecap/captures', () =>
      json({ items: world.captures, nextCursor: null }),
    ),
    at('/api/v1/webhook-endpoints/wecap/captures/secret', () => json({ secret: 'whsec_cap' })),
    at('/api/v1/webhook-endpoints/we1', (_url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH') return json({ ...HOOK, ...JSON.parse(String(init?.body)) });
      if (method === 'DELETE') return json({ ok: true });
      return json(HOOK);
    }),
    at('/api/v1/webhook-endpoints/we1/deliveries', () =>
      json({ items: world.deliveries.we1 ?? [], nextCursor: null }),
    ),
    at('/api/v1/webhook-endpoints/we1/tests', () => json({ items: [] })),
    at('/api/v1/webhook-endpoints/we-new/test', () =>
      json({ ok: true, status: 200, durationMs: 9, errorCode: null, captureId: null }),
    ),
    at('/api/v1/webhook-endpoints/we-new/deliveries', () => json({ items: [], nextCursor: null })),
    at('/api/v1/webhook-endpoints/we-new/tests', () => json({ items: [] })),
    at('/api/v1/templates', () => json({ items: [], nextCursor: null })),
  ];
  for (const e of world.events) {
    routes.push(
      at(`/api/v1/events/${e.id}/deliveries`, () => json({ items: world.deliveries[e.id] ?? [] })),
      at(`/api/v1/events/${e.id}`, () => json(e)),
    );
  }
  for (const c of world.captures)
    routes.push(at(`/api/v1/webhook-endpoints/wecap/captures/${c.id}`, () => json(c)));
  routes.push(
    at('/api/v1/webhook-endpoints/we1/deliveries/ev2', () =>
      json({ ...detail({ eventId: 'ev2' }), payload: feedEvent('ev2') }),
    ),
  );
  return { ...shell(world.summary), ...Object.fromEntries(routes) };
}

/** A wide window: the inspector sits beside the list. */
export function wideWindow() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('1180') || q.includes('720') || q.includes('reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

export const delivery = (
  endpointId: string,
  eventId: string,
  target: 'url' | 'capture',
  over = {},
) => ({
  endpointId,
  target,
  eventId,
  type: 'pass.scanned',
  passId: 'p1234567890',
  externalId: 'ORD-7',
  state: 'delivered',
  attempts: 1,
  nextAt: NOW,
  lastStatus: 200,
  lastError: null,
  lastAttemptAt: NOW - 3_000_000,
  finishedAt: NOW - 3_000_000,
  replays: 0,
  ...over,
});
