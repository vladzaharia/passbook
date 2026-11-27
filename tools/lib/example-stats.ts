// The world's numbers over time: the gym's last seven days of metrics and a developer's sandbox day. Every series
// sums to its total and every total agrees with the counts beside it. Pure data.
import { hex, IDS, keySecret, T } from './example-world.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const uuid = (seed: string): string => `0193a1b2-7c00-7000-8000-${hex(seed, 12)}`;
/** The start of each of the last seven days, oldest first. */
const DAYS = Array.from({ length: 7 }, (_, i) => Math.floor(T.now / DAY) * DAY - (6 - i) * DAY);
/** A week's weight per day: quiet midweek, busy weekend (the scan day is Tuesday 24 November). */
const WEEK = [3, 5, 6, 4, 3, 3, 4];

/** `total` spread over `buckets` by `weights`, whole numbers that add up to it exactly. */
export function spread(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - out.reduce((a, b) => a + b, 0);
  for (let i = out.length - 1; left > 0; i = (i + out.length - 1) % out.length, left--)
    out[i] = (out[i] as number) + 1;
  return out;
}
const daily = (total: number) => spread(total, WEEK).map((v, i) => ({ t: DAYS[i] as number, v }));

/** Northwind's week: 128 active passes, a new design rolled out, the front desk scanning about 140 a day. */
const WEEK_TOTALS = {
  issued: 23,
  updated: 151,
  downloads: 31,
  registrations: 38,
  refreshes: 980,
  pushes: 920,
  pushFailures: 4,
  emails: 23,
  emailFailures: 1,
  emailUnknown: 2,
  syncRuns: 672,
  signIns: 9,
  scans: 994,
};
export const METRICS = {
  source: 'analytics_engine',
  range: '7d',
  bucketMs: DAY,
  unavailable: [],
  totals: {
    passes: 131,
    activePasses: 128,
    voidedPasses: 3,
    holders: 126,
    devices: 214,
    ...WEEK_TOTALS,
    scanRefused: 27,
  },
  series: Object.fromEntries(Object.entries(WEEK_TOTALS).map(([k, v]) => [k, daily(v)])),
  setup: {
    orgs: 1,
    assignedTemplates: 3,
    passes: 131,
    approvedTemplates: 3,
    releasedTemplates: 2,
    walletPasses: 117,
    passEmailsSent: 126,
    latestPassId: IDS.pass,
    scanners: 4,
  },
  directory: { users: 4, walletAccounts: 1 },
  live: [
    { eventId: IDS.event, name: 'Open climbing', arrived: 46, expected: 128, ratePerMin: 1.8 },
  ],
  recent: [
    { at: T.recent, action: 'pass.create', orgId: IDS.org, targetId: IDS.pass },
    { at: T.now - 40 * 60_000, action: 'template.release', orgId: IDS.org, targetId: IDS.template },
  ],
};

/** The same week by template: the Day pass and the monthly membership add up to the org's totals. */
const DAY_PASS = {
  templateId: IDS.template,
  name: 'Day pass',
  issued: 17,
  added: 14,
  removed: 2,
  scans: 245,
  redemptions: 0,
  inWallet: 81,
  notAdded: 9,
};
const MONTHLY = {
  templateId: uuid('template-monthly'),
  name: 'Monthly membership',
  issued: 6,
  added: 5,
  removed: 0,
  scans: 749,
  redemptions: 12,
  inWallet: 36,
  notAdded: 2,
};
const sumOf = (k: keyof typeof DAY_PASS) => (DAY_PASS[k] as number) + (MONTHLY[k] as number);
export const ACTIVITY = {
  range: '7d',
  bucketMs: DAY,
  totals: Object.fromEntries(
    (['issued', 'added', 'removed', 'scans', 'redemptions', 'inWallet', 'notAdded'] as const).map(
      (k) => [k, sumOf(k)],
    ),
  ),
  series: { issued: daily(sumOf('issued')), scans: daily(sumOf('scans')) },
  templates: [MONTHLY, DAY_PASS],
};

/** The developer's sandbox: its own Test org, opened two weeks ago, the quickstart finished in 15 minutes. */
const SANDBOX_ORG = uuid('org-sandbox');
const opened = T.created;
export const SANDBOX = {
  id: uuid('sandbox'),
  orgId: SANDBOX_ORG,
  orgSlug: 'northwind-sandbox',
  name: 'Northwind sandbox',
  templateId: uuid('template-sandbox-ticket'),
  mode: 'test',
  previewOnly: true,
  createdAt: opened,
  closedAt: null,
  closeReason: null,
  reopenUntil: null,
  limits: { passes: 100, templates: 5, endpoints: 3, keys: 3 },
};
const SANDBOX_KEY_ID = uuid('key-sandbox');
export const SANDBOX_KEY = {
  id: SANDBOX_KEY_ID,
  name: 'Sandbox key',
  secret: keySecret('s4Ndb0xK'),
  mode: 'test',
  expiresAt: opened + 30 * DAY,
};
/** One call the sandbox key made: a pass list from the TypeScript SDK. */
export const CALL = {
  id: uuid('call'),
  requestId: uuid('request'),
  at: T.recent,
  method: 'GET',
  route: '/api/v1/passes',
  path: '/api/v1/passes',
  query: 'limit=25',
  status: 200,
  code: null,
  durationMs: 84,
  keyId: SANDBOX_KEY_ID,
  mode: 'test',
  client: '@passbook/sdk 1.4.2',
  hasBodies: true,
  resourceId: null,
  apiVersion: '2026-11-01',
  flags: { idempotencyKey: false, ifMatch: false, version: true },
  requestBody: null,
  responseBody: '{"items":[],"nextCursor":null}',
  bodiesExpireAt: T.recent + 7 * DAY,
  bodiesRecorded: true,
  bodiesTruncated: false,
  headers: {
    req: {
      accept: 'application/json',
      'passbook-version': '2026-11-01',
      'user-agent': '@passbook/sdk 1.4.2',
    },
    res: { 'content-type': 'application/json', etag: '"3"' },
  },
};
/** The developer's day, by local hour of the last 24: work from 08:00 to 22:00, busiest after lunch. */
const HOURS = Array.from({ length: 24 }, (_, i) =>
  i >= 13 && i <= 18 ? 4 : i >= 8 && i <= 21 ? 2 : 0,
);
export const DEVELOPER_HOME = {
  now: T.now,
  state: 'open',
  sandbox: SANDBOX,
  progress: {
    startedAt: opened,
    restartedAt: null,
    sandboxAt: opened + 60_000,
    keyCallAt: opened + 5 * 60_000,
    passAt: opened + 8 * 60_000,
    changeAt: opened + 12 * 60_000,
    webhookAt: opened + 15 * 60_000,
    doneAt: opened + 15 * 60_000,
    doneMs: 15 * 60_000,
    next: null,
  },
  usage: {
    calls24h: 38,
    errors24h: 5,
    captures24h: 6,
    passes: 9,
    series: {
      from: Math.floor(T.now / HOUR) * HOUR - 23 * HOUR,
      calls: spread(38, HOURS),
      errors: spread(
        2,
        HOURS.map((h, i) => (i === 16 || i === 19 ? h : 0)),
      ),
    },
  },
  keys: [
    {
      id: SANDBOX_KEY_ID,
      name: 'Sandbox key',
      secretPrefix: 'pb_test_s4Ndb0xK',
      scopes: ['passes:read', 'passes:write', 'templates:read', 'webhooks:manage'],
      createdAt: opened,
      expiresAt: SANDBOX_KEY.expiresAt,
      lastUsedAt: T.recent,
      retireAt: null,
      sandboxKey: true,
    },
  ],
  calls: [CALL],
  liveOrgs: [{ id: IDS.org, name: 'Northwind Climbing', slug: 'northwind-climbing' }],
};
