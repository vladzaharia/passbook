// Hand-written examples of the REST probe: a customer list from a Stripe-style API, page 1 of 2.
import { IDS } from './example-world.ts';

const config = {
  baseUrl: 'https://api.northwind.example/v1',
  auth: { type: 'bearer' },
  list: {
    path: '/customers',
    query: [{ name: 'limit', value: '2' }],
    recordsPointer: '/data',
    idPointer: '/id',
    pagination: {
      style: 'cursor',
      param: 'starting_after',
      from: 'last-id',
      hasMorePointer: '/has_more',
    },
  },
};
const request = {
  orgId: IDS.org,
  connectorType: 'http-json',
  config,
  secrets: { token: 'nw_live_••••3f9c' },
  target: 'list',
};
const response = {
  ok: true,
  durationMs: 312,
  request: {
    method: 'GET',
    url: 'https://api.northwind.example/v1/customers?limit=2',
    status: 200,
    bytes: 1184,
    contentType: 'application/json',
  },
  headers: {
    'content-type': 'application/json',
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '99',
  },
  body: {
    object: 'list',
    has_more: true,
    data: [
      {
        id: 'cus_1001',
        email: 'ada@example.com',
        full_name: 'Ada Example',
        created: '2026-02-03T10:00:00Z',
      },
      {
        id: 'cus_1002',
        email: 'grace@example.com',
        full_name: 'Grace Okafor',
        created: '2026-02-04T09:30:00Z',
      },
    ],
  },
  pruned: { arrays: [], strings: 0, depthCut: false, nodesCut: false },
  detections: {
    records: [{ pointer: '/data', jsonPath: '$.data[*]', count: 2, score: 0.75, reason: 'name' }],
    pagination: [
      {
        confidence: 'high',
        config: { ...config.list.pagination, cursorPointer: '' },
        evidence: 'field:/has_more',
      },
    ],
    id: [{ pointer: '/id', jsonPath: '$.data[*].id', unique: true, score: 0.95 }],
    updatedAt: [{ pointer: '/created', jsonPath: '$.data[*].created', format: 'iso', score: 0.5 }],
    holderEmail: [{ pointer: '/email', jsonPath: '$.data[*].email' }],
    fields: [
      {
        pointer: '/id',
        jsonPath: '$.data[*].id',
        label: 'id',
        type: 'text',
        samples: ['cus_1001', 'cus_1002'],
      },
      {
        pointer: '/email',
        jsonPath: '$.data[*].email',
        label: 'email',
        type: 'email',
        samples: ['ada@example.com', 'grace@example.com'],
      },
      {
        pointer: '/name',
        jsonPath: '$.data[*].name',
        label: 'name',
        type: 'text',
        samples: ['Ada Example', 'Grace Okafor'],
      },
      {
        pointer: '/created',
        jsonPath: '$.data[*].created',
        label: 'created',
        type: 'date',
        samples: ['2026-02-03T10:00:00Z', '2026-02-04T09:30:00Z'],
      },
    ],
    rateLimit: { limit: 100, remaining: 99 },
  },
  page: {
    index: 1,
    from: 1,
    to: 2,
    overlap: 0,
    next: 'p1.eyJwIjp7ImMiOiJjdXNfMTAwMiJ9LCJrIjoxLCJuIjoyLCJpZHMiOlsiMXN6Il19',
  },
};

/** `<operationId> <request|response>` to its example. */
export const CONNECTION_PROBE_EXAMPLES: Record<string, unknown> = {
  'connections.postConnectionsProbe request': request,
  'connections.postConnectionsProbe response': response,
  'connections.postConnectionsByIdProbe request': {
    target: 'list',
    next: response.page.next,
  },
  'connections.postConnectionsByIdProbe response': {
    ...response,
    page: { index: 2, from: 3, to: 3, overlap: 0, next: null },
  },
};
