import { json } from '@/web/lib/test-utils.tsx';

const series = (vals: number[]) =>
  vals.map((v, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, v }));
const none = series([]);

const setup = {
  orgs: 2,
  assignedTemplates: 3,
  passes: 1200,
  approvedTemplates: 2,
  releasedTemplates: 0,
  walletPasses: 800,
  passEmailsSent: 9,
  latestPassId: 'p9',
  scanners: 0,
};

export const overview = (over: Record<string, unknown> = {}) => ({
  source: 'analytics_engine',
  range: '7d',
  bucketMs: 86_400_000,
  unavailable: [],
  directory: { users: 7, walletAccounts: 4 },
  totals: {
    passes: 1200,
    activePasses: 1100,
    voidedPasses: 100,
    holders: 900,
    devices: 800,
    issued: 40,
    updated: 12,
    downloads: 33,
    pushFailures: 2,
    registrations: 0,
    refreshes: 0,
    pushes: 0,
    emails: 0,
    emailFailures: 0,
    emailUnknown: 0,
    syncRuns: 0,
    signIns: 0,
    scans: 0,
    scanRefused: 0,
  },
  series: {
    issued: series([1, 3, 2]),
    updated: series([0, 0, 0]),
    downloads: none,
    registrations: none,
    refreshes: none,
    pushes: series([5, 1]),
    pushFailures: none,
    emails: none,
    emailFailures: none,
    emailUnknown: none,
    syncRuns: none,
    signIns: none,
    scans: none,
  },
  setup,
  live: [],
  recent: [],
  ...over,
});

const component = (id: string, kind: string, label: string, state: string) => ({
  id,
  kind,
  label,
  state,
  detail: null,
  checkedAt: 1,
});
export const status = {
  overall: 'failing',
  build: { id: null, tag: null, timestamp: null },
  components: [
    component('connections', 'connection', 'Connections', 'failing'),
    component('connection:c1', 'connection', 'Box office feed', 'failing'),
    component('d', 'database', 'D1', 'verified'),
  ],
};

const entry = (id: number, action: string, target: Record<string, unknown> = {}) => ({
  id,
  at: Date.now() - id * 60_000,
  orgId: null,
  actorType: 'user',
  actorId: 'u1',
  actorLabel: 'Ada',
  action,
  targetType: null,
  targetId: null,
  targetLabel: null,
  requestId: null,
  detail: null,
  ...target,
});
export const audit = {
  items: [
    entry(1, 'pass.void', { targetType: 'pass', targetId: 'p1', targetLabel: 'Clara Rossi' }),
    entry(2, 'settings.update'),
  ],
  nextCursor: null,
};

export const funnel = {
  windowDays: 30,
  sandboxes: 40,
  viewed: 32,
  called: 20,
  passed: 14,
  previewed: 9,
  completion: 0.4375,
  ttfpP50Ms: 240_000,
  ttfpP90Ms: 1_080_000,
  ttfpSamples: 14,
};

export const ok = {
  '/api/v1/metrics/platform/developer': () => json(funnel),
  '/api/v1/metrics/platform/overview': () => json(overview()),
  '/api/v1/status': () => json(status),
  '/api/v1/audit/platform': () => json(audit),
  '/api/v1/identities': () => json({ items: [], nextCursor: null }),
};

export function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const day = 86_400_000;
const orgSeries = (vals: number[]) => vals.map((v, i) => ({ t: 1_700_000_000_000 + i * day, v }));

/** An organization's activity by template, as GET /api/v1/metrics/activity returns it. */
export const orgActivity = (over: Record<string, unknown> = {}) => ({
  range: '7d',
  bucketMs: day,
  totals: {
    issued: 40,
    added: 30,
    removed: 2,
    scans: 25,
    redemptions: 9,
    inWallet: 120,
    notAdded: 18,
  },
  series: { issued: orgSeries([1, 4, 2, 6]), scans: orgSeries([0, 3, 9, 13]) },
  templates: [
    {
      templateId: 't1',
      name: 'Member card',
      issued: 30,
      added: 24,
      removed: 1,
      scans: 20,
      redemptions: 9,
      inWallet: 90,
      notAdded: 10,
    },
    {
      templateId: 't2',
      name: 'Day pass',
      issued: 10,
      added: 6,
      removed: 1,
      scans: 5,
      redemptions: 0,
      inWallet: 30,
      notAdded: 8,
    },
  ],
  ...over,
});
