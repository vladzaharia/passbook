import type { SetupGuide } from '@/shared/contracts/connection-setup.ts';
import type { RecipeId } from '@/shared/contracts/connections.ts';
import { type FetchHandler, json } from '../../lib/test-utils.tsx';
import { CONNECTOR, connectionDetail, ORG } from '../passes/test-fixtures.ts';
import guides from './setup-guides.fixture.json';

/** The server's guides, as JSON (a worker test pins this file to them). */
export const GUIDES = guides as unknown as Record<RecipeId, SetupGuide>;
export const RECIPE_IDS = Object.keys(GUIDES) as RecipeId[];
export const URL_C9 = 'https://wallet.example/hooks/c/c9';

export const WEBHOOK_CONNECTOR = {
  ...CONNECTOR,
  type: 'webhook-push',
  displayName: 'Webhook push',
  description: 'Your system sends signed records.',
  capabilities: { poll: false, delta: false, webhook: true, import: false, snapshot: false },
  configSchema: { type: 'object', properties: {} },
  secretSchema: null,
  recipes: RECIPE_IDS.filter((id) => id !== 'custom').map((id) => ({
    id,
    label: GUIDES[id].provider.name,
    category: 'commerce',
    pasteSecret: GUIDES[id].secret.origin === 'provider',
    secretOrigin: GUIDES[id].secret.origin,
    line: 'Record to pass.',
    entitled: true,
    outputFields: {},
    mapping: {},
    holderEmailField: '/email',
    voidWhen: [],
  })),
};

export function setupOf(recipe: RecipeId, values: Record<string, unknown> = {}) {
  const custom = recipe === 'custom';
  return {
    ...GUIDES[recipe],
    values: {
      endpointUrl: URL_C9,
      signatureHeader: custom ? 'x-passbook-signature' : null,
      timestampHeader: custom ? 'x-passbook-timestamp' : null,
      hasSecret: true,
      ...values,
    },
  };
}

export function webhookDetail(recipe: RecipeId, over: Record<string, unknown> = {}) {
  return connectionDetail({
    id: 'c9',
    connectorType: 'webhook-push',
    name: 'Orders in',
    config: recipe === 'custom' ? {} : { recipe },
    mode: 'webhook',
    hasWebhookSecret: true,
    health: 'awaiting',
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorAt: null,
    lastRunAt: null,
    lastSuccessAt: null,
    runs: [],
    webhookUrl: URL_C9,
    createdAt: 1,
    ...over,
  });
}

let n = 0;
/** One ledger row, as the server returns it. */
export function ledgerRow(over: Record<string, unknown> = {}) {
  n += 1;
  return {
    id: `arr${n}`,
    receivedAt: 1_700_000_000_000,
    lastAt: 1_700_000_000_000,
    outcome: 'accepted',
    reason: null,
    topic: null,
    contentClass: 'json',
    eventRef: null,
    usedPrevious: false,
    count: 1,
    ...over,
  };
}

/** Handlers for the setup page: the connection, its guide with values, and the fake ledger. */
export function setupHandlers(
  recipe: RecipeId,
  opts: {
    rows?: Record<string, unknown>[];
    values?: Record<string, unknown>;
    detail?: Record<string, unknown>;
    patches?: Record<string, unknown>[];
  } = {},
): Record<string, FetchHandler> {
  const detail = webhookDetail(recipe, opts.detail);
  return {
    '/api/v1/orgs': () => json({ items: [ORG], nextCursor: null }),
    '/api/v1/connectors': () => json({ items: [WEBHOOK_CONNECTOR], nextCursor: null }),
    '/api/v1/connectors/webhook-push': () => json(WEBHOOK_CONNECTOR),
    '/api/v1/connections/c9': (_u: URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PATCH')
        opts.patches?.push(JSON.parse(String(init?.body)));
      return json(detail);
    },
    '/api/v1/connections/c9/setup': () => json(setupOf(recipe, opts.values)),
    '/api/v1/connections/c9/webhook-arrivals': () =>
      json({ items: opts.rows ?? [], nextCursor: null }),
  };
}
