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
  quotas: {
    passes: { used: 0, limit: 500 },
    templates: { used: 1, limit: 10 },
    endpoints: { used: 1, limit: 3 },
    keys: { used: 2, limit: 3 },
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

export const homeFresh: DeveloperHome = { ...base(), state: 'open', progress: progress() };
