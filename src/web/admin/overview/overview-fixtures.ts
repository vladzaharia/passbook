import { json } from '@/web/lib/test-utils.tsx';

const series = (vals: number[]) =>
  vals.map((v, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, v }));
const none = series([]);

const setup = {
  orgs: 2,
  assignedTemplates: 3,
  passes: 1200,
  passEmailsSent: 9,
  latestPassId: 'p9',
  scanners: 0,
};

export const overview = (over: Record<string, unknown> = {}) => ({
  source: 'analytics_engine',
  range: '7d',
  bucketMs: 86_400_000,
  unavailable: [],
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

export const ok = {
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
