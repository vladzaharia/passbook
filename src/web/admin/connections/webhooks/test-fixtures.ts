import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import { type FetchHandler, json, membershipFixture } from '../../../lib/test-utils.tsx';
import { ORG } from '../../passes/test-fixtures.ts';

export const NOW = Date.now();
export const HOUR = 3_600_000;
export const manager = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });
export const reader = membershipFixture(ORG.id, {
  orgName: ORG.name,
  orgSlug: ORG.slug,
  capabilities: ['integrations:read'],
});

export function endpoint(over: Partial<WebhookEndpointDto> = {}): WebhookEndpointDto {
  return {
    id: 'we1',
    orgId: ORG.id,
    mode: 'live',
    url: 'https://hooks.example.com/passbook/abcd1234',
    urlMasked: 'hooks.example.com/…1234',
    description: 'Orders',
    eventTypes: ['pass.issued', 'pass.scanned'],
    templateIds: null,
    apiVersion: '2026-11-20',
    status: 'active',
    target: 'url',
    failingSince: null,
    disabledAt: null,
    lastSuccessAt: NOW - HOUR,
    lastFailureAt: null,
    lastStatus: 200,
    secretCreatedAt: NOW - 24 * HOUR,
    previousSecretExpiresAt: null,
    createdAt: NOW - 24 * HOUR,
    ...over,
  };
}

export function delivery(over: Record<string, unknown> = {}) {
  return {
    eventId: 'ev1',
    type: 'pass.scanned',
    passId: 'p1234567890',
    externalId: 'ORD-7',
    state: 'failed',
    attempts: 3,
    nextAt: NOW + HOUR,
    lastStatus: 503,
    lastError: null,
    lastAttemptAt: NOW - HOUR,
    finishedAt: null,
    replays: 0,
    ...over,
  };
}

export const detail = (over: Record<string, unknown> = {}) => ({
  ...delivery(),
  attemptLog: [
    {
      attempt: 1,
      trigger: 'event',
      status: 503,
      errorCode: null,
      durationMs: 120,
      at: NOW - 3 * HOUR,
    },
    {
      attempt: 2,
      trigger: 'retry',
      status: null,
      errorCode: 'TIMEOUT',
      durationMs: 10_000,
      at: NOW - 2 * HOUR,
    },
  ],
  payload: {
    id: 'ev1',
    type: 'pass.scanned',
    apiVersion: '2026-11-20',
    createdAt: NOW - 3 * HOUR,
    orgId: ORG.id,
    mode: 'live',
    pass: { id: 'p1234567890', externalId: 'ORD-7', templateId: 't1' },
    data: { outcome: 'ok' },
  },
  ...over,
});

export interface Calls {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

/** Handlers for the webhook routes; every request is recorded in `calls`. */
export function hooks(
  calls: Calls[],
  state: { endpoints: WebhookEndpointDto[]; deliveries?: unknown[] } = { endpoints: [endpoint()] },
  extra: Record<string, FetchHandler> = {},
): Record<string, FetchHandler> {
  const log = (url: URL, init?: RequestInit) =>
    calls.push({
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      search: url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
  const first = () => state.endpoints[0] as WebhookEndpointDto;
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/connections': () => json({ items: [], nextCursor: null }),
    '/api/v1/connectors': () => json({ items: [], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [], nextCursor: null }),
    '/api/v1/webhook-endpoints': (url, init) => {
      log(url, init);
      if ((init?.method ?? 'GET') === 'POST')
        return url.searchParams.get('validate')
          ? json({ ok: true })
          : json({ endpoint: endpoint({ id: 'we-new' }), secret: 'whsec_shown_once' }, 201);
      return json({ items: state.endpoints, nextCursor: null });
    },
    '/api/v1/webhook-endpoints/we1': (url, init) => {
      log(url, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH') {
        Object.assign(first(), JSON.parse(String(init?.body)));
        return json(first());
      }
      if (method === 'DELETE') return json({ ok: true });
      return json(first());
    },
    '/api/v1/webhook-endpoints/we-new': (url, init) => {
      log(url, init);
      return json(endpoint({ id: 'we-new' }));
    },
    '/api/v1/webhook-endpoints/we-new/test': (url, init) => {
      log(url, init);
      return json({ ok: true, status: 200, durationMs: 140, errorCode: null, captureId: null });
    },
    '/api/v1/webhook-endpoints/we1/deliveries': (url, init) => {
      log(url, init);
      const want = url.searchParams.get('state');
      const items = (state.deliveries ?? [
        delivery(),
        delivery({ eventId: 'ev2', state: 'delivered', lastStatus: 200, type: 'pass.issued' }),
      ]) as { state: string }[];
      return json({
        items: want ? items.filter((d) => d.state === want) : items,
        nextCursor: null,
      });
    },
    '/api/v1/webhook-endpoints/we1/deliveries/ev1': (url, init) => {
      log(url, init);
      return json(detail());
    },
    '/api/v1/webhook-endpoints/we1/deliveries/ev1/replay': (url, init) => {
      log(url, init);
      return json({ queued: 1 });
    },
    '/api/v1/webhook-endpoints/we1/replay': (url, init) => {
      // The dialog's count is a dry run of the same request: not a replay, so not recorded.
      if (!JSON.parse(String(init?.body)).dryRun) log(url, init);
      return json({ queued: 42 });
    },
    '/api/v1/webhook-endpoints/we1/secret': (url, init) => {
      log(url, init);
      return json({ secret: 'whsec_rotated' });
    },
    '/api/v1/webhook-endpoints/we1/test': (url, init) => {
      log(url, init);
      return json({ ok: true, status: 200, durationMs: 140, errorCode: null, captureId: null });
    },
    ...extra,
  };
}
