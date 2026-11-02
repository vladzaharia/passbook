/** Contract-shaped fixtures for page tests. */
export const ORG = {
  id: 'org1',
  slug: 'henrys',
  name: "Henry's",
  status: 'active',
  defaultIdentityId: null,
  branding: {},
  createdAt: 1,
  updatedAt: 1,
  counts: { passes: 2, templates: 1, connections: 1, apiKeys: 0 },
  countsCapped: false,
};

export const INPUT_SCHEMA = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', 'x-label': 'Member name', 'x-order': 1, minLength: 2 },
    level: {
      type: 'string',
      enum: ['copper', 'blue'],
      'x-enumLabels': { copper: 'Copper', blue: 'Blue' },
      'x-order': 2,
    },
  },
};

export const SAMPLE_PASS_JSON = {
  formatVersion: 1,
  organizationName: "Henry's",
  description: 'Membership',
  generic: {},
};

export function templateSummary(over: Record<string, unknown> = {}) {
  return {
    id: 'tpl1',
    orgId: 'org1',
    orgName: "Henry's",
    slug: 'copper',
    name: 'Copper card',
    description: null,
    origin: 'uploaded',
    status: 'active',
    activeVersion: 'a1b2c3d4e5f6a7b8',
    styles: ['generic'],
    passCount: 2,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

export function templateDetail(over: Record<string, unknown> = {}) {
  return {
    ...templateSummary(),
    inputSchema: INPUT_SCHEMA,
    sample: { name: 'Sam' },
    manifest: { inputs: INPUT_SCHEMA },
    versions: [
      {
        version: 'a1b2c3d4e5f6a7b8',
        createdAt: 1,
        createdBy: null,
        assets: [],
        report: {
          ok: true,
          issues: [{ severity: 'warning', code: 'IMG_SCALE', message: 'Missing @3x icon.' }],
        },
        active: true,
        passCount: 2,
      },
      {
        version: 'ffeeddccbbaa9988',
        createdAt: 2,
        createdBy: null,
        assets: [],
        report: {
          ok: false,
          issues: [
            {
              severity: 'error',
              code: 'BAD_FIELD',
              message: 'Duplicate key.',
              path: 'generic.primaryFields',
            },
          ],
        },
        active: false,
        passCount: 0,
      },
    ],
    passesOnOlderVersions: 0,
    ...over,
  };
}

export function passSummary(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    orgId: 'org1',
    templateId: 'tpl1',
    templateVersion: 'a1b2c3d4e5f6a7b8',
    identityId: 'idn1',
    serial: 'SER-001',
    title: 'Sam Jones',
    subtitle: null,
    externalId: null,
    status: 'active',
    version: 3,
    connectionId: null,
    syncErrorCode: null,
    holderEmail: 'sam@example.com',
    holderState: 'waiting',
    ownerUserId: null,
    deviceCount: 2,
    modifiedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

export function passDetail(over: Record<string, unknown> = {}) {
  return {
    ...passSummary(),
    ownerName: null,
    ownerEmail: null,
    personalization: { name: 'Sam Jones', level: 'copper' },
    fieldSources: { name: 'manual', level: 'manual' },
    passJson: SAMPLE_PASS_JSON,
    assetBaseUrl: '/p/tok/assets',
    assetNames: ['icon.png'],
    blockedUsers: [],
    downloadUrl: '/p/tok/pass.pkpass',
    publicUrl: '/p/tok',
    registrations: 2,
    devices: [
      {
        shortId: 'a1b2c3',
        createdAt: 1_700_000_000_000,
        lastPush: { state: 'sent', at: 1_700_000_100_000 },
      },
      { shortId: 'd4e5f6', createdAt: 1_700_000_000_000, lastPush: null },
    ],
    lastRefreshedAt: null,
    versions: [
      {
        version: 3,
        templateVersion: 'a1b2c3d4e5f6a7b8',
        cause: 'admin',
        actorType: 'user',
        actorId: 'u1',
        createdAt: 3,
        purged: false,
      },
      {
        version: 2,
        templateVersion: 'a1b2c3d4e5f6a7b8',
        cause: 'create',
        actorType: 'user',
        actorId: 'u1',
        createdAt: 2,
        purged: false,
      },
      {
        version: 1,
        templateVersion: 'a1b2c3d4e5f6a7b8',
        cause: 'create',
        actorType: null,
        actorId: null,
        createdAt: 1,
        purged: true,
      },
    ],
    deliveries: [
      {
        id: 'd1',
        kind: 'email',
        state: 'failed',
        attempts: 3,
        errorCode: 'MAIL_REJECTED',
        createdAt: 5,
        finishedAt: 6,
      },
      {
        id: 'd2',
        kind: 'push',
        state: 'sent',
        attempts: 1,
        errorCode: null,
        createdAt: 4,
        finishedAt: 4,
      },
    ],
    voided: null,
    warnings: [],
    templateWarnings: [],
    ...over,
  };
}

export function connection(over: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    orgId: 'org1',
    connectorType: 'http-json',
    connectorVersion: 1,
    name: 'MemberSpot sync',
    config: {},
    hasCredential: true,
    hasWebhookSecret: false,
    mapping: { name: { from: '/member/name', transform: { kind: 'trim' } } },
    defaultTemplateId: 'tpl1',
    holderEmailField: '/member/email',
    autoCreate: false,
    autoEmail: false,
    onMissing: 'flag',
    mode: 'poll',
    intervalSeconds: 3600,
    maxConcurrency: null,
    requestsPerMinute: null,
    enabled: true,
    health: 'degraded',
    consecutiveFailures: 2,
    breakerOpenUntil: null,
    nextRunAt: null,
    lastRunAt: 1_700_000_000_000,
    lastSuccessAt: 1_699_000_000_000,
    lastErrorCode: 'UPSTREAM_5XX',
    lastErrorAt: 1_700_000_000_000,
    webhookUrl: 'https://wallet.example/hooks/connections/c1',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

export function connectionDetail(over: Record<string, unknown> = {}) {
  return {
    ...connection(),
    runs: [
      {
        id: 'r1',
        trigger: 'schedule',
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_000,
        outcome: 'error',
        recordsSeen: null,
        passesChanged: null,
        errorCode: 'UPSTREAM_5XX',
        errorDetail: 'm-1: INVALID name required\nm-2: INVALID level not allowed',
        httpStatus: 503,
        durationMs: 1000,
      },
      {
        id: 'r2',
        trigger: 'admin',
        startedAt: 1_699_000_000_000,
        finishedAt: 1_699_000_001_000,
        outcome: 'changed',
        recordsSeen: 10,
        passesChanged: 2,
        errorCode: null,
        httpStatus: 200,
        durationMs: 400,
      },
    ],
    metrics: { p50Ms: 400, p95Ms: 900, errorRate: 0.25, passCount: 2 },
    ...over,
  };
}

export const CONNECTOR = {
  type: 'http-json',
  version: 1,
  displayName: 'HTTP JSON',
  capabilities: { poll: true, delta: false, webhook: true, import: false, snapshot: false },
  configSchema: {
    type: 'object',
    required: ['baseUrl'],
    properties: { baseUrl: { type: 'string', format: 'uri', 'x-label': 'Base URL' } },
  },
  secretSchema: {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string', 'x-label': 'Bearer token' } },
  },
  outputFields: { name: { type: 'string' }, email: { type: 'string' } },
  defaults: { intervalSeconds: 3600, maxConcurrency: 2, requestsPerMinute: 60, timeoutMs: 15000 },
};

/** GET /templates/previews: the sample preview for every requested id. */
export function previewsHandler(url: URL): Response {
  const items = (url.searchParams.get('ids') ?? '')
    .split(',')
    .filter(Boolean)
    .map((id) => ({
      id,
      passJson: SAMPLE_PASS_JSON,
      warnings: [],
      assetBaseUrl: '/a',
      assetNames: [],
    }));
  return new Response(JSON.stringify({ items }), {
    headers: { 'content-type': 'application/json' },
  });
}
