import type { RequestLogEntry } from '../../../shared/contracts/developer.ts';
import type { DeveloperHome } from '../../../shared/contracts/developer-home.ts';

/** Home payloads for tests and the visual harness: none, fresh, progressed, done and closed. */
export const NOW = Date.UTC(2026, 10, 21, 15, 30);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ORG = '019a0000-0000-7000-8000-00000000d0e5';

const live = [
  {
    orgId: '019a-live-1',
    name: 'Henry’s Bakery',
    slug: 'henrys',
    roles: ['org_admin' as const],
    canMintLive: true,
  },
  {
    orgId: '019a-live-2',
    name: 'Rain City Fit',
    slug: 'rain-city',
    roles: ['read_only' as const],
    canMintLive: true,
  },
];

const call = (i: number, over: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  id: `019a-log-${String(i).padStart(3, '0')}`,
  requestId: `req-${i}`,
  at: NOW - i * 3 * MIN,
  method: 'GET',
  route: '/api/v1/passes',
  path: '/api/v1/passes',
  query: null,
  status: 200,
  code: null,
  durationMs: 40 + i * 7,
  keyId: '019a-key-1',
  mode: 'test',
  via: null,
  client: 'curl/8.7.1',
  hasBodies: true,
  resourceId: null,
  apiVersion: null,
  flags: { idempotencyKey: false, ifMatch: false, version: false },
  ...over,
});

const series = (peak: number) =>
  Array.from({ length: 24 }, (_, i) => Math.round(peak * Math.abs(Math.sin(i / 3))));

const base = (): Omit<DeveloperHome, 'state' | 'progress'> => ({
  now: NOW,
  sandbox: {
    id: '019a-sbx',
    orgId: ORG,
    orgSlug: 'dev-a1b2c3d4e5f6',
    name: 'Sandbox a1b2c3d4e5f6',
    templateId: '019a-tpl',
    mode: 'test',
    previewOnly: true,
    createdAt: NOW - 2 * HOUR,
    closedAt: null,
    closeReason: null,
    reopenUntil: null,
    limits: { passes: 500, templates: 10, endpoints: 3, keys: 3 },
  },
  usage: {
    calls24h: 0,
    errors24h: 0,
    captures24h: 0,
    passes: 0,
    series: { from: NOW - 23 * HOUR, calls: series(0), errors: series(0) },
  },
  keys: [
    {
      id: '019a-key-1',
      name: 'Sandbox key',
      secretPrefix: 'pbp_test_Ab12Cd',
      scopes: ['passes:read', 'passes:write', 'templates:read'],
      createdAt: NOW - 2 * HOUR,
      expiresAt: NOW + 30 * DAY - 2 * HOUR,
      lastUsedAt: null,
      retireAt: null,
      sandboxKey: true,
    },
  ],
  calls: [],
  endpoints: [
    {
      id: '019a-ep-capture',
      target: 'capture',
      url: null,
      status: 'active',
      eventTypes: ['pass.issued', 'pass.updated'],
      lastAt: null,
      lastOk: null,
    },
  ],
  passes: [],
  liveOrgs: live,
});

const progress = (over: Partial<DeveloperHome['progress'] & object> = {}) => ({
  startedAt: NOW - 2 * HOUR - 40_000,
  restartedAt: null,
  sandboxAt: NOW - 2 * HOUR,
  keyCallAt: null,
  passAt: null,
  changeAt: null,
  webhookAt: null,
  doneAt: null,
  doneMs: null,
  next: 'call' as const,
  ...over,
});

export const homeNone: DeveloperHome = {
  ...base(),
  state: 'none',
  sandbox: null,
  progress: null,
  usage: null,
  keys: [],
  endpoints: [],
};

export const homeFresh: DeveloperHome = { ...base(), state: 'open', progress: progress() };

const pass = (i: number, title: string, subtitle: string) => ({
  id: `019a-pass-${i}`,
  templateId: '019a-tpl',
  title,
  subtitle,
  status: 'active' as const,
  version: i === 1 ? 2 : 1,
  createdAt: NOW - i * 20 * MIN,
  modifiedAt: NOW - i * 10 * MIN,
  previewUrl: `https://passbook.test/test-preview/${i}`,
});

const used = (): Partial<DeveloperHome> => ({
  usage: {
    calls24h: 1284,
    errors24h: 37,
    captures24h: 18,
    passes: 12,
    series: { from: NOW - 23 * HOUR, calls: series(140), errors: series(6) },
  },
  calls: [
    call(0, { method: 'PATCH', route: '/api/v1/passes/:id', status: 200 }),
    call(1, { method: 'POST', status: 201, durationMs: 212 }),
    call(2, { status: 422, code: 'INPUT_INVALID', method: 'POST' }),
    call(3, { via: 'try' }),
    call(4, { method: 'DELETE', route: '/api/v1/passes/:id', status: 404, code: 'PASS_NOT_FOUND' }),
    call(5, { route: '/api/v1/templates', path: '/api/v1/templates' }),
  ],
  passes: [
    pass(1, 'QS-1042', 'VIP · Hall B'),
    pass(2, 'QS-1041', 'General'),
    pass(3, 'QS-1040', 'General'),
  ],
});

export const homeProgressed: DeveloperHome = {
  ...base(),
  ...used(),
  keys: base().keys.map((k) => ({ ...k, lastUsedAt: NOW })),
  state: 'open',
  progress: progress({ keyCallAt: NOW - 90 * MIN, passAt: NOW - 90 * MIN, next: 'change' }),
};

export const homeDone: DeveloperHome = {
  ...homeProgressed,
  keys: [
    { ...(base().keys[0] as DeveloperHome['keys'][number]), lastUsedAt: NOW - 3 * MIN },
    {
      id: '019a-key-2',
      name: 'CI',
      secretPrefix: 'pbp_test_demo01',
      scopes: ['passes:read'],
      createdAt: NOW - HOUR,
      expiresAt: NOW + 7 * DAY,
      lastUsedAt: NOW - 20 * MIN,
      retireAt: NOW + HOUR,
      sandboxKey: false,
    },
  ],
  endpoints: [
    {
      ...(base().endpoints[0] as DeveloperHome['endpoints'][number]),
      lastAt: NOW - 2 * MIN,
      lastOk: true,
    },
    {
      id: '019a-ep-url',
      target: 'url',
      url: 'https://hooks.example.dev/passbook',
      status: 'active',
      eventTypes: ['pass.issued'],
      lastAt: NOW - 30 * MIN,
      lastOk: false,
    },
  ],
  progress: progress({
    keyCallAt: NOW - 2 * HOUR + 3 * MIN,
    passAt: NOW - 2 * HOUR + 3 * MIN,
    changeAt: NOW - 2 * HOUR + 3.4 * MIN,
    webhookAt: NOW - 2 * HOUR + 3 * MIN + 2000,
    doneAt: NOW - 2 * HOUR + 3.4 * MIN,
    doneMs: 202_000,
    next: null,
  }),
};

export const homeClosed: DeveloperHome = {
  ...homeDone,
  state: 'closed',
  sandbox: {
    ...(homeDone.sandbox as NonNullable<DeveloperHome['sandbox']>),
    closedAt: NOW - 2 * DAY,
    closeReason: 'user',
    reopenUntil: NOW + 28 * DAY,
  },
  keys: [],
};
