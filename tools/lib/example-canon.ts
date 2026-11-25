// The world's resources as the API returns them: one of each, consistent with each other (ids, names, times, counts).
// The sampler trims each to the schema in hand and fills what it leaves out, so one object serves every operation
// that shows that resource. Pure data.
import {
  API,
  BUNDLE_URL,
  CANON,
  hex,
  IDS,
  KEY_PREFIX,
  PAIRING_CODE,
  SCAN_CODE,
  T,
  TEMPLATE,
  webhookSecret,
} from './example-world.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const uuid = (seed: string): string => `0193a1b2-7c00-7000-8000-${hex(seed, 12)}`;
/** The start of a local hour of the scan day (24 November, Pacific time), as epoch ms. */
export const localHour = (h: number): number => Date.UTC(2026, 10, 24, h + 8, 0, 0);

/** The ready card a desk sees for the Day pass: the template's scan display, filled for Ada. */
export const DISPLAY = {
  v: 1,
  screen: 'ready',
  templateVersion: '3',
  variant: null,
  identity: { holder: 'Ada Example', initials: 'AE', photo: null },
  header: {
    icon: null,
    title: 'Welcome back',
    titleLines: 1,
    meta: 'Valid until 31 Dec 2026',
    chips: [{ id: 'tier', text: 'Day pass', tone: 'teal', icon: null }],
  },
  panels: [
    {
      id: 'details',
      kind: 'details',
      title: 'Details',
      icon: null,
      tone: null,
      rows: [
        {
          type: 'field',
          id: 'name',
          label: 'Guest',
          value: 'Ada Example',
          icon: 'user',
          strong: true,
        },
        {
          type: 'field',
          id: 'validUntil',
          label: 'Valid until',
          value: '31 Dec 2026',
          icon: 'calendar',
          strong: false,
        },
      ],
    },
  ],
  notes: { staff: null, refused: null },
};

/** What the front desk's counter shows: today's scans and tonight's event. */
export const SCAN_COUNTS = {
  today: 142,
  event: { arrived: 46, inside: 38, expected: 128, capacity: 120 },
  place: null,
  byType: [
    { templateId: uuid('template-monthly'), name: 'Monthly membership', count: 96 },
    { templateId: IDS.template, name: TEMPLATE.name, count: 35 },
  ],
  asOf: T.recent,
  configRev: 7,
};

const admit = { id: 'admit', label: 'Admit', kind: 'check_in' };
/** Ada's day pass, scanned at the front desk and admitted. */
export const SCAN_OK = {
  scanId: IDS.scan,
  kind: 'ok',
  reason: null,
  replay: false,
  action: admit,
  flags: [],
  at: T.recent,
  checkIn: {
    mode: 'daily',
    direction: 'in',
    inside: true,
    enteredAt: T.recent,
    firstAt: T.recent,
    validFrom: T.validFrom,
    validUntil: T.validUntil,
  },
  card: {
    passId: IDS.pass,
    version: 1,
    mode: 'live',
    title: 'Day pass',
    subtitle: 'Ada Example',
    template: { id: IDS.template, name: TEMPLATE.name, style: 'generic' },
    status: 'active',
    validFrom: T.validFrom,
    validUntil: T.validUntil,
    flags: [],
    values: [],
    actions: [
      {
        ...admit,
        available: true,
        lock: null,
        reason: null,
        amount: null,
        confirm: false,
        confirmAbove: null,
        cooldownRemainingMs: null,
        armable: null,
        rewardLabel: null,
      },
    ],
    display: DISPLAY,
    // The pass JSON minus barcode and serial, and a short-lived grant for its images (scan/assets.ts).
    passView: {
      passJson: Object.fromEntries(
        Object.entries(TEMPLATE.passJson).filter(([k]) => k !== 'serialNumber'),
      ),
      assetBaseUrl: `/api/v1/scan/passes/${IDS.pass}/assets/`,
      assetGrant: `demo-token-northwind-${hex('asset-grant', 22)}`,
      assetNames: ['icon.png', 'icon@2x.png', 'logo.png'],
    },
    lastScans: [],
    bundle: null,
    door: { state: 'in' },
    access: null,
    tag: null,
    occupancy: null,
  },
  display: { ...DISPLAY, screen: 'ok' },
  template: { name: TEMPLATE.name, style: 'generic' },
  cooldownRemainingMs: null,
  value: null,
  overridable: false,
  approvals: false,
  counts: SCAN_COUNTS,
  undoUntil: T.recent + 2 * MIN,
  bundle: null,
  group: null,
  tag: null,
  previous: null,
  milestone: null,
};

/** The front desk's day so far: 142 scans, the parts adding up. */
export const SCAN_SUMMARY = {
  from: T.now - 24 * HOUR,
  to: T.now,
  total: 142,
  ok: 131,
  headsUp: 7,
  refused: 4,
  undone: 2,
  byAction: [
    { actionId: 'admit', label: 'Admit', count: 119, amount: 0 },
    { actionId: 'add-visit', label: 'Use a visit', count: 12, amount: 12 },
  ],
  firstAt: localHour(6) + 7 * MIN,
  lastAt: T.recent,
  scope: 'session',
  timeZone: 'America/Los_Angeles',
  byHour: [
    { start: localHour(6), label: '06:00', count: 18, refused: 0 },
    { start: localHour(7), label: '07:00', count: 24, refused: 1 },
    { start: localHour(12), label: '12:00', count: 21, refused: 0 },
    { start: localHour(16), label: '16:00', count: 33, refused: 1 },
    { start: localHour(17), label: '17:00', count: 46, refused: 2 },
  ],
  byValue: [{ kind: 'take', count: 12, amount: 12 }],
  byReason: [
    { reason: 'already_done', count: 6 },
    { reason: 'expired', count: 3 },
    { reason: 'cooldown', count: 1 },
    { reason: 'no_balance', count: 1 },
  ],
  byType: [
    { templateId: uuid('template-monthly'), name: 'Monthly membership', count: 96 },
    { templateId: IDS.template, name: TEMPLATE.name, count: 35 },
  ],
  byStaff: [
    { staffId: IDS.staff, name: 'Sam Rivera', count: 90, overrides: 1, refused: 3 },
    { staffId: uuid('staff-priya'), name: 'Priya Nair', count: 52, overrides: 1, refused: 1 },
  ],
  overrides: {
    count: 2,
    latest: [
      {
        scanId: uuid('scan-override-2'),
        at: localHour(17) + 12 * MIN,
        staffName: 'Sam Rivera',
        approvedBy: 'Priya Nair',
        reason: 'already_done',
      },
      {
        scanId: uuid('scan-override-1'),
        at: localHour(7) + 40 * MIN,
        staffName: 'Priya Nair',
        approvedBy: 'Priya Nair',
        reason: 'no_balance',
      },
    ],
  },
};

/** The gym's booking system, told about passes. */
export const WEBHOOK_ENDPOINT = {
  id: IDS.endpoint,
  orgId: IDS.org,
  mode: 'live',
  url: 'https://bookings.northwind.example.com/hooks/passbook',
  urlMasked: 'https://bookings.northwind.example.com/…',
  description: 'Front-desk check-in sync',
  eventTypes: ['pass.issued', 'pass.scanned'],
  templateIds: [IDS.template],
  apiVersion: '2026-12-01',
  status: 'active',
  target: 'url',
  failingSince: null,
  disabledAt: null,
  lastSuccessAt: T.recent,
  lastFailureAt: T.updated,
  lastStatus: 200,
  secretCreatedAt: T.created,
  previousSecretExpiresAt: null,
  createdAt: T.created,
};
export const WEBHOOK_SECRET = webhookSecret('endpoint');

const issued = T.recent - 2 * MIN;
/** The `pass.issued` event for Ada's pass, delivered on the first try. */
export const DELIVERY = {
  eventId: IDS.delivery,
  type: 'pass.issued',
  passId: IDS.pass,
  externalId: 'booking_8841',
  state: 'delivered',
  attempts: 1,
  // The claim parks the next try 5 minutes out (webhooks/schedule.ts CLAIM_HOLD_MS); delivery leaves it there.
  nextAt: issued + 5 * MIN,
  lastStatus: 200,
  lastError: null,
  lastAttemptAt: issued,
  finishedAt: issued + 240,
  replays: 0,
  attemptLog: [
    { attempt: 1, trigger: 'event', status: 200, errorCode: null, durationMs: 240, at: issued },
  ],
  payload: {
    id: IDS.delivery,
    type: 'pass.issued',
    apiVersion: '2026-12-01',
    createdAt: issued,
    orgId: IDS.org,
    mode: 'live',
    pass: { id: IDS.pass, externalId: 'booking_8841', templateId: IDS.template },
    data: { version: 1, source: 'api' },
  },
};

/** The server integration's key: test mode, issuing and reading passes. */
export const API_KEY = {
  id: IDS.key,
  orgId: IDS.org,
  name: 'Server integration',
  prefix: KEY_PREFIX,
  secretPrefix: `pb_test_${KEY_PREFIX}`,
  scopes: ['passes:read', 'passes:write', 'templates:read'],
  mode: 'test',
  createdBy: IDS.user,
  createdByName: 'Sam Rivera',
  createdAt: T.created,
  lastUsedAt: T.recent,
  expiresAt: null,
  revokedAt: null,
  kind: 'service',
  retireAt: null,
  ipAllow: [],
  templateIds: [],
  passStyles: [],
  rateTier: 'standard',
  parentKeyId: null,
  rotatedFrom: null,
  lastIpPrefix: '203.0.113',
  parent: null,
  replacedBy: null,
  childCount: 0,
};

/** What the server integration did lately (api-keys/repo-family.ts reads the audit log). */
export const KEY_ACTIVITY = {
  lastUsedAt: T.recent,
  lastIpPrefix: '203.0.113',
  summary: {
    since: T.created,
    calls: 412,
    denied: 1,
    actions: [
      { action: 'pass.create', count: 128, lastAt: T.recent },
      { action: 'pass.update', count: 41, lastAt: T.updated },
      { action: 'auth.denied', count: 1, lastAt: T.updated },
    ],
  },
  recent: [
    {
      id: 90412,
      at: T.recent,
      action: 'pass.create',
      outcome: 'allowed',
      targetType: 'pass',
      targetId: IDS.pass,
      ipPrefix: '203.0.113',
      code: null,
    },
    {
      id: 90377,
      at: T.updated,
      action: 'auth.denied',
      outcome: 'denied',
      targetType: null,
      targetId: null,
      ipPrefix: '203.0.113',
      code: 'MISSING_SCOPE',
    },
  ],
};

/** Holiday hours, sent to every Day pass holder. */
export const BROADCAST = {
  id: IDS.broadcast,
  orgId: IDS.org,
  mode: 'live',
  kind: 'message',
  name: 'Holiday hours',
  state: 'sent',
  target: { templateIds: [IDS.template] },
  patch: {},
  notify: true,
  at: T.recent,
  /** A duration: the message clears 31 days after it was sent, on Christmas Day. */
  clearAfter: 31 * 24 * HOUR,
  parentId: null,
  message: 'The gym closes at 18:00 on 24 December.',
  ruleId: null,
  followUp: null,
  counts: { targeted: 128, updated: 121, unchanged: 0, overBudget: 0, failed: 7 },
  errorCode: null,
  createdAt: T.recent - 10 * MIN,
  startedAt: T.recent,
  finishedAt: T.recent + 3 * MIN,
};

/** Seven days before a membership ends, its holder hears about it. */
export const MESSAGE_RULE = {
  id: IDS.rule,
  orgId: IDS.org,
  mode: 'live',
  name: 'Renewal reminder',
  templateIds: [IDS.template],
  anchor: { kind: 'input', input: 'validUntil' },
  offset: { amount: 7, unit: 'day', when: 'before' },
  yearly: false,
  sendAt: '09:00',
  timeZone: 'America/Los_Angeles',
  message: 'Your membership renews in 7 days.',
  clearAfter: 7 * 24 * HOUR,
  on: true,
  state: 'on',
  pausedCode: null,
  nextCheckAt: Date.UTC(2026, 10, 25, 17, 0, 0),
  sent: 42,
  skipped: 3,
  createdAt: T.created,
  updatedAt: T.updated,
  version: 2,
};
/** This morning's run of the rule: a message broadcast to the nine holders whose pass ends in a week. */
export const RULE_RUN = {
  ...BROADCAST,
  id: uuid('broadcast-rule-run'),
  name: MESSAGE_RULE.name,
  message: MESSAGE_RULE.message,
  ruleId: IDS.rule,
  notify: true,
  at: localHour(9),
  clearAfter: 7 * 24 * HOUR,
  counts: { targeted: 9, updated: 9, unchanged: 0, overBudget: 0, failed: 0 },
  createdAt: localHour(9),
  startedAt: localHour(9),
  finishedAt: localHour(9) + 40_000,
};

/** The booking sheet: a published CSV, polled every 15 minutes. */
export const CONNECTION_RUN = {
  id: IDS.run,
  trigger: 'schedule',
  startedAt: T.recent,
  finishedAt: T.recent + 1800,
  outcome: 'changed',
  recordsSeen: 3,
  passesChanged: 1,
  passesCreated: 1,
  passesVoided: 0,
  recordsFailed: 0,
  errorCode: null,
  errorDetail: null,
  httpStatus: 200,
  durationMs: 1800,
};
export const CONNECTION = {
  id: IDS.connection,
  orgId: IDS.org,
  connectorType: 'csv-url',
  connectorVersion: 1,
  name: 'Booking sheet',
  config: {
    url: 'https://docs.google.com/spreadsheets/d/e/2PACX-northwind-bookings/pub?output=csv',
    idColumn: 'Booking ID',
  },
  hasCredential: false,
  hasWebhookSecret: false,
  mapping: {
    name: { from: '/Name' },
    tier: { from: '/Plan' },
    validUntil: { from: '/Valid until' },
  },
  defaultTemplateId: IDS.template,
  holderEmailField: '/Email',
  autoCreate: true,
  autoEmail: true,
  onMissing: 'keep',
  voidWhen: [],
  webhookPrevUntil: null,
  mode: 'poll',
  intervalSeconds: 900,
  maxConcurrency: 1,
  requestsPerMinute: 6,
  enabled: true,
  health: 'healthy',
  consecutiveFailures: 0,
  breakerOpenUntil: null,
  nextRunAt: T.recent + 15 * MIN,
  lastRunAt: T.recent,
  lastSuccessAt: T.recent,
  lastErrorCode: null,
  lastErrorAt: null,
  webhookUrl: null,
  createdAt: T.created,
  updatedAt: T.updated,
  runs: [CONNECTION_RUN],
  metrics: { p50Ms: 1650, p95Ms: 2400, errorRate: 0, passCount: 3 },
};

const release = uuid('release-4');
/** When version 4 of the Day pass was released. */
export const RELEASED_AT = T.now - 40 * MIN;
/** Releasing version 4 of the Day pass: Test follows at once, Live after a peer's approval. */
export const RELEASE = {
  version: '4',
  modes: {
    test: {
      outcome: 'released',
      releaseId: uuid('release-4-test'),
      generation: 4,
      approvalKind: 'test',
    },
    live: { outcome: 'released', releaseId: release, generation: 4, approvalKind: 'peer' },
  },
  state: {
    live: { version: '4', at: RELEASED_AT, by: 'Priya Nair' },
    test: { version: '4', at: RELEASED_AT, state: 'following' },
    draft: null,
    review: { state: 'none' },
    alone: false,
    next: null,
  },
};
/** The package check of the Day pass: one warning, nothing blocking (templates/package/images.ts). */
const REPORT = {
  ok: true,
  issues: [
    {
      severity: 'warning',
      code: 'IMAGE_DERIVED',
      message: 'icon@2x.png derived from the @3x image.',
      path: 'icon@2x.png',
    },
  ],
};
const candidate4 = uuid('candidate-4');
const approval4 = uuid('approval-4');
const hash4 = hex('candidate-hash-4', 64);
/** Version 4 for Apple Wallet in Live: Sam built it, Priya approved it. */
export const CANDIDATE = {
  id: candidate4,
  templateId: IDS.template,
  orgId: IDS.org,
  mode: 'live',
  provider: 'apple',
  version: '4',
  contentHash: hex('content-hash-4', 64),
  candidateHash: hash4,
  adapterRevision: 1,
  adapterCapabilities: ['issue', 'update'],
  audiencePolicyRevision: 1,
  authorId: IDS.user,
  versionAuthorId: IDS.user,
  authorName: 'Sam Rivera',
  versionAuthorName: 'Sam Rivera',
  createdAt: RELEASED_AT - 2 * HOUR,
  approvals: [
    {
      id: approval4,
      candidateId: candidate4,
      candidateHash: hash4,
      reviewerId: uuid('user-priya'),
      reviewerName: 'Priya Nair',
      kind: 'peer',
      createdAt: RELEASED_AT - MIN,
    },
  ],
};
/** The release record of version 4 in Live. */
export const RELEASE_ROW = {
  id: release,
  templateId: IDS.template,
  orgId: IDS.org,
  mode: 'live',
  provider: 'apple',
  version: '4',
  generation: 4,
  candidateHash: hash4,
  source: 'approved',
  action: 'release',
  previousReleaseId: uuid('release-3'),
  createdBy: uuid('user-priya'),
  createdByName: 'Priya Nair',
  createdAt: RELEASED_AT,
  candidateId: candidate4,
  approvalId: approval4,
};
/** Version 3 of the Day pass as stored: its images, its check, its manifest. */
export const TEMPLATE_VERSION = {
  version: '3',
  createdAt: T.updated,
  createdBy: IDS.user,
  assets: [
    ['icon.png', 'icon', 1, 29, 29, 1620],
    ['icon@2x.png', 'icon', 2, 58, 58, 3410],
    ['logo.png', 'logo', 1, 160, 50, 6240],
  ].map(([name, slot, scale, width, height, size]) => ({
    name,
    slot,
    scale,
    size,
    sha1: hex(`asset-${name}`, 40),
    crc32: Number.parseInt(hex(`crc-${name}`, 8), 16),
    width,
    height,
  })),
  report: REPORT,
  active: true,
  displayOnly: false,
  passCount: 128,
  manifest: {
    fields: {
      name: { type: 'string', label: 'Guest', required: true },
      tier: { type: 'string', label: 'Pass' },
      validUntil: { type: 'date', label: 'Valid until' },
    },
  },
  passJson: TEMPLATE.passJson,
};

/** Version 4 of the Day pass, released 40 minutes ago and still reaching passes. */
export const ROLLOUT = {
  releaseVersion: '4',
  releaseId: release,
  fromVersion: '3',
  total: 128,
  onRelease: 121,
  remaining: 7,
  updating: [{ version: '3', count: 5 }],
  failedCount: 2,
  failed: [
    { passId: uuid('pass-grace'), title: 'Day pass', reason: 'The pass changed. Retry.' },
    {
      passId: uuid('pass-alan'),
      title: 'Ten-visit card',
      reason: 'The card has 12 stamps; this version allows 10. Raise the maximum or redeem first.',
    },
  ],
  startedAt: RELEASED_AT,
  runId: `bulk-${release}`,
  running: true,
  stalled: false,
  changes: [
    {
      group: 'colors',
      rows: [
        {
          label: 'Background',
          kind: 'changed',
          from: { type: 'color', color: 'rgb(17, 42, 74)' },
          to: { type: 'color', color: 'rgb(12, 74, 64)' },
        },
      ],
      more: 0,
    },
    {
      group: 'front',
      rows: [
        {
          label: 'Auxiliary: Valid until',
          kind: 'changed',
          from: { type: 'text', text: '31 Dec 2026' },
          to: { type: 'text', text: '31 Jan 2027' },
        },
      ],
      more: 0,
    },
  ],
  tell: {
    text: 'Day pass has a new design.',
    until: RELEASED_AT + 24 * HOUR,
    key: `rollout-tell:${release}`,
  },
};

/** The Day pass package, uploaded and checked: one warning, nothing blocking. */
export const UPLOAD = {
  uploadId: uuid('upload-day-pass'),
  name: 'day-pass.zip',
  status: 'complete',
  step: null,
  templateId: IDS.template,
  version: '3',
  error: null,
  report: REPORT,
  issues: 1,
  createdAt: T.updated,
};

/** Open climbing tonight: the event the front desk scans for. */
export const SCAN_EVENT = {
  id: IDS.event,
  orgId: IDS.org,
  mode: 'live',
  name: 'Open climbing',
  templateIds: [IDS.template],
  match: null,
  opensAt: localHour(17),
  closesAt: localHour(22),
  timeZone: 'America/Los_Angeles',
  capacity: 120,
  reentry: true,
  hardLimit: false,
  note: 'Doors open 30 minutes early for members.',
  status: 'live',
  arrived: 46,
  expected: 128,
  scanners: 2,
};

/** The import's rows, as committed: Ada and Grace created, Alan updated, Mei unchanged, Chris left out. */
export const IMPORT_ROWS = {
  items: [
    {
      row: 2,
      action: 'create',
      state: 'done',
      result: 'created',
      passId: IDS.pass,
      externalId: 'NW-1001',
      code: null,
      message: null,
      emailed: true,
    },
    {
      row: 3,
      action: 'create',
      state: 'done',
      result: 'created',
      passId: uuid('pass-grace'),
      externalId: 'NW-1002',
      code: null,
      message: null,
      emailed: true,
    },
    {
      row: 4,
      action: 'update',
      state: 'done',
      result: 'updated',
      passId: uuid('pass-alan'),
      externalId: 'NW-1003',
      code: null,
      message: null,
      emailed: false,
      changes: [{ key: 'validUntil', label: 'Valid until', from: '2026-12-31', to: '2027-01-15' }],
    },
    {
      row: 5,
      action: 'unchanged',
      state: 'done',
      result: 'unchanged',
      passId: uuid('pass-mei'),
      externalId: 'NW-1004',
      code: null,
      message: null,
      emailed: false,
    },
    {
      row: 6,
      action: 'error',
      state: 'skipped',
      result: null,
      passId: null,
      externalId: 'NW-1005',
      code: 'EMAIL_INVALID',
      message: 'Email is not valid.',
      emailed: false,
    },
  ],
  nextCursor: null,
};

/** Pairing a new front-desk tablet. */
export const PAIRING = {
  code: PAIRING_CODE,
  url: `${API}/scan#pair=${PAIRING_CODE}`,
  expiresAt: T.now + 10 * MIN,
};

/** What a scan request sends: the pass's barcode, read by the camera. */
export const SCAN_INPUT = { code: SCAN_CODE, method: 'camera' };

const level = (state: string, reason?: string, at: 'passbook' | 'org' = 'org') => [
  {
    level: 'passbook',
    state: at === 'passbook' ? state : 'ok',
    ...(at === 'passbook' && reason ? { reason } : {}),
    canChange: false,
  },
  { level: 'plan', state: 'ok', canChange: false },
  {
    level: 'org',
    state: at === 'org' ? state : 'ok',
    ...(at === 'org' && reason ? { reason } : {}),
    canChange: true,
  },
  { level: 'template', state: 'ok', canChange: true },
  { level: 'pass', state: 'ok', canChange: true },
];
/**
 * Where the Day pass reaches holders: Apple Wallet, the web pass and paper. Google and Samsung are not released on
 * the platform yet (the first level that stops a channel names it), and the org has no tags.
 */
export const EFFECTIVE = {
  mobile: { on: true, source: 'template' },
  apple: { on: true, source: 'template' },
  google: { on: false, source: 'platform', reason: 'not_released' },
  samsung: { on: false, source: 'platform', reason: 'not_released' },
  paper: { on: true, source: 'template' },
  nfc: { on: false, source: 'org', reason: 'tags_off' },
};
export const CHANNELS = {
  effective: EFFECTIVE,
  levels: {
    mobile: level('ok'),
    apple: level('ok'),
    google: level('locked', 'not_released', 'passbook'),
    samsung: level('locked', 'not_released', 'passbook'),
    paper: level('ok'),
    nfc: level('off', 'tags_off'),
  },
  overrides: {},
  replace: { supported: false, windows: [] },
};

/** A bulk removal of the Day passes: 128 targeted, two already gone. */
export const BULK_RUN = {
  id: uuid('bulk-run-remove'),
  orgId: IDS.org,
  action: 'remove',
  state: 'done',
  total: 128,
  done: 126,
  skipped: 2,
  skippedBy: { PASS_REMOVED: 2 },
  stopRequested: false,
  createdAt: T.now - 6 * MIN,
  finishedAt: T.now - MIN,
  code: null,
};

/** The front desk's door rules: once a day per pass (contracts/scan.ts CheckInPolicy). */
export const CHECK_IN_POLICY = { mode: 'daily' };

/** The tablet at the front desk, paired and online. */
export const SCANNER = {
  id: IDS.scanner,
  orgId: IDS.org,
  mode: 'live',
  kind: 'device',
  deviceRole: 'scan',
  name: 'Front desk',
  accepts: { templateIds: [IDS.template], eventIds: [IDS.event] },
  timeZone: 'America/Los_Angeles',
  status: 'paired',
  online: true,
  pairedAt: T.created,
  pairedLabel: 'Front desk tablet',
  lastSeenAt: T.recent,
  expiresAt: null,
  staff: null,
  today: 142,
  createdAt: T.created,
  pairing: null,
};

/** Tonight's shift at the front desk: one tablet, open until 22:00. */
export const SESSION = {
  id: IDS.session,
  orgId: IDS.org,
  orgName: 'Northwind Climbing',
  mode: 'live',
  name: 'Evening shift',
  status: 'active',
  accepts: { templateIds: [IDS.template], eventIds: [IDS.event] },
  zoneIds: [IDS.zone],
  timeZone: 'America/Los_Angeles',
  hold: null,
  createdAt: T.created,
  updatedAt: T.updated,
  deviceCount: 1,
  onlineCount: 1,
  today: 142,
};

/** The session's tablet at the front desk. */
export const SESSION_DEVICE = {
  id: IDS.device,
  sessionId: IDS.session,
  name: 'Front desk tablet',
  surface: 'auto',
  effectiveSurface: 'phone',
  overrides: {},
  online: true,
  paired: true,
  revoked: false,
  lastSeenAt: T.recent,
  createdAt: T.created,
  updatedAt: T.updated,
};

/** The main hall: tracked, 120 inside at most, cleared at 04:00. */
export const ZONE = {
  occupancy: 'track',
  capacity: 120,
  maxStayMinutes: null,
  hardLimit: false,
  clearAt: '04:00',
  id: IDS.zone,
  orgId: IDS.org,
  key: 'main-hall',
  name: 'Main hall',
  parentId: null,
  timeZone: null,
  effectiveTimeZone: 'America/Los_Angeles',
  sort: 1,
  depth: 0,
  sessions: 1,
  checkedAt: [{ id: IDS.scanner, name: 'Front desk' }],
  plans: [
    {
      templateId: IDS.template,
      templateName: TEMPLATE.name,
      planId: 'always',
      label: 'Always open',
    },
  ],
  inNow: 38,
  archivedAt: null,
};

/** Sam at the front desk: a desk role, on shift since six. */
export const STAFF = {
  id: IDS.staff,
  orgId: IDS.org,
  name: 'Sam Rivera',
  role: 'desk',
  pinSetAt: T.created,
  pinResetRequired: false,
  pinLockedToday: false,
  locked: false,
  disabledAt: null,
  today: 90,
  lastScan: { at: T.recent, scannerName: 'Front desk' },
};

/** Ada's pass holder record: emailed, not yet claimed by an account. */
export const HOLDER = {
  passId: IDS.pass,
  state: 'waiting',
  email: 'ada@example.com',
  ownerUserId: null,
  ownerName: null,
  blockedUserIds: [],
  transfer: null,
  reissueRequired: false,
  updatedAt: T.updated,
};

/** Ada's family: her day pass and her son's youth pass, behind one link. */
export const BUNDLE = {
  id: IDS.bundle,
  orgId: IDS.org,
  mode: 'live',
  name: 'Family pack',
  url: BUNDLE_URL,
  holderEmail: 'ada@example.com',
  passes: [
    { id: IDS.pass, title: 'Day pass', status: 'active', removedAt: null },
    { id: uuid('pass-youth'), title: 'Youth session pass', status: 'active', removedAt: null },
  ],
  createdAt: T.updated,
  linkRotatedAt: null,
};

/** What a capture endpoint stored instead of sending: the signed request, as it would have gone out. */
export const CAPTURE = {
  id: uuid('capture'),
  endpointId: IDS.endpoint,
  eventId: IDS.delivery,
  type: 'pass.issued',
  trigger: 'event',
  status: 200,
  durationMs: 0,
  headers: {
    'content-type': 'application/json',
    'user-agent': 'PassBook-Webhooks/1.0',
    'x-passbook-event-id': IDS.delivery,
    'x-passbook-event-type': 'pass.issued',
    'x-passbook-timestamp': String(Math.floor(issued / 1000)),
  },
  createdAt: issued,
};

/** A roll call of the main hall, six minutes in: 31 confirmed, 4 out, 3 still to find. */
export const ROLL_CALL = {
  id: IDS.rollCall,
  placeNames: ['Main hall'],
  startedAt: T.now - 6 * MIN,
  startedBy: IDS.user,
  endedAt: null,
  endedBy: null,
  rev: 7,
  serverNow: T.now,
  counts: {
    total: 38,
    present: 31,
    out: 4,
    unconfirmed: 3,
    notConfirmedOut: 0,
    late: 0,
    inNow: 34,
    tappedIn: 38,
  },
  people: [
    {
      passId: IDS.pass,
      holder: 'Ada Example',
      plan: 'Always open',
      host: null,
      place: 'zone:main-hall',
      placeName: 'Main hall',
      since: T.recent,
      basis: 'in_now',
      presence: 'in',
      late: false,
      notConfirmedOut: false,
      mark: { status: 'present', by: 'Sam Rivera', at: T.now - MIN },
    },
  ],
};

/** The member wristband: one per pass, checked by staff when it is handed over. */
export const TAG_TYPE = {
  id: uuid('tag-type-wristband'),
  system: 'uid',
  name: 'Member wristband',
  use: 'member',
  scopes: 'pass',
  perPass: 1,
  bindingDays: null,
  confirm: 'staff',
  typed: false,
  templateIds: [IDS.template],
  version: 1,
  tagCount: 40,
  createdAt: T.created,
  updatedAt: T.created,
};

/** The keys the gym's door tags are written with. */
export const KEYSET = {
  id: IDS.keyset,
  name: 'Gym doors',
  slug: 'gymdoors',
  diversify: true,
  perTag: false,
  createdAt: T.created,
  disabledAt: null,
  versions: [
    {
      version: 1,
      state: 'active',
      createdAt: T.created,
      stateAt: T.created,
      revokedAt: null,
      tags: 40,
    },
  ],
};

/** The org as a platform admin lists it. */
export const ORG_ROW = {
  id: IDS.org,
  slug: 'northwind-climbing',
  name: 'Northwind Climbing',
  status: 'active',
  personal: false,
  personalOwner: null,
  createdAt: Date.UTC(2026, 2, 3, 18, 0, 0),
  counts: { passes: 128, templates: 2, connections: 1, apiKeys: 2, members: 4 },
  countsCapped: false,
};

/** Ada's own view of her pass, in the holder portal. */
export const MY_PASS = {
  id: IDS.pass,
  title: 'Day pass',
  subtitle: 'Ada Example',
  templateName: TEMPLATE.name,
  orgName: 'Northwind Climbing',
  status: 'active',
  mode: 'live',
  modifiedAt: T.updated,
  voidedAt: null,
  removedAt: null,
  removalMessage: null,
  lastRefreshedAt: T.updated + 3 * MIN,
  refreshRequestedAt: null,
  inWallet: true,
  readOnly: false,
};

/** The gym's own signing identity: managed by PassBook, valid to 31 December, pushes healthy. */
const CERT_FROM = Date.UTC(2025, 11, 31, 8, 0, 0);
export const IDENTITY = {
  id: IDS.identity,
  orgId: IDS.org,
  label: 'Northwind signing identity',
  passTypeIdentifier: 'pass.mobile.passbook.northwind',
  teamIdentifier: 'A1B2C3D4E5',
  source: 'db',
  certSha256: hex('identity-cert', 64),
  certSubject: 'CN=Pass Type ID: pass.mobile.passbook.northwind',
  certSerial: hex('identity-serial', 16),
  notBefore: CERT_FROM,
  notAfter: T.validUntil,
  daysRemaining: Math.floor((T.validUntil - T.now) / (24 * HOUR)),
  apnsBinding: 'production',
  apnsAvailable: true,
  pushMethod: 'certificate',
  pushKey: null,
  apnsHealth: 'healthy',
  apnsCheckedAt: T.recent,
  apnsReason: 'BadDeviceToken',
  passCount: 131,
  nfcEnabled: false,
  nfcKeys: [],
  isDefault: true,
  createdAt: CERT_FROM,
  kind: 'managed',
  status: 'active',
  rotation: 'auto',
  issuing: true,
  nextRotationAt: T.validUntil - 30 * 24 * HOUR,
  handle: 'northwind',
};
/** The run that renewed the identity's certificate this afternoon. */
export const IDENTITY_RUN = {
  id: uuid('identity-run'),
  orgId: IDS.org,
  kind: 'rotate',
  targetType: 'identity',
  targetId: IDS.identity,
  state: 'succeeded',
  step: 'done',
  attempt: 1,
  waitingFor: null,
  errorCode: null,
  createdAt: T.now - 3 * MIN,
  updatedAt: T.now - MIN,
  finishedAt: T.now - MIN,
};
/** Last week's export of the org's data, ready to download for a few more days. */
export const EXPORT = {
  id: uuid('export'),
  state: 'ready',
  createdAt: T.now - 2 * 24 * HOUR,
  finishedAt: T.now - 2 * 24 * HOUR + 4 * MIN,
  expiresAt: T.now + 5 * 24 * HOUR,
  bytes: 1_843_200,
  entities: { passes: 131, templates: 3, holders: 126, scans: 4210 },
  errorCode: null,
};

/** Object shapes the API repeats, by properties that give them away, to the world's own object. */
export const SHAPES: { has: string[]; value: Record<string, unknown> }[] = [
  ...CANON,
  { has: ['kind', 'card', 'replay'], value: SCAN_OK },
  { has: ['today', 'asOf', 'configRev'], value: SCAN_COUNTS },
  { has: ['headsUp', 'undone', 'byAction'], value: SCAN_SUMMARY },
  { has: ['urlMasked', 'eventTypes', 'target'], value: WEBHOOK_ENDPOINT },
  { has: ['eventId', 'attempts', 'nextAt', 'replays'], value: DELIVERY },
  { has: ['prefix', 'scopes'], value: API_KEY },
  { has: ['anchor', 'offset', 'sendAt'], value: MESSAGE_RULE },
  { has: ['kind', 'target', 'counts', 'notify'], value: BROADCAST },
  { has: ['connectorType', 'config', 'onMissing'], value: CONNECTION },
  { has: ['trigger', 'outcome', 'recordsSeen'], value: CONNECTION_RUN },
  { has: ['releaseVersion', 'onRelease', 'failedCount'], value: ROLLOUT },
  { has: ['uploadId', 'status'], value: UPLOAD },
  { has: ['action', 'skippedBy', 'stopRequested'], value: BULK_RUN },
  { has: ['effective', 'levels', 'overrides'], value: CHANNELS },
  { has: ['durationFrom', 'durationMinutes', 'days'], value: CHECK_IN_POLICY },
  { has: ['deviceRole', 'accepts', 'settings'], value: SCANNER },
  { has: ['accepts', 'settings', 'deviceCount', 'onlineCount'], value: SESSION },
  { has: ['sessionId', 'surface', 'effectiveSurface'], value: SESSION_DEVICE },
  { has: ['occupancy', 'clearAt', 'checkedAt'], value: ZONE },
  { has: ['pinSetAt', 'pinResetRequired', 'role'], value: STAFF },
  { has: ['blockedUserIds', 'transfer', 'ownerUserId'], value: HOLDER },
  { has: ['holderEmail', 'passes', 'linkRotatedAt'], value: BUNDLE },
  { has: ['slug', 'counts', 'countsCapped'], value: ORG_ROW },
  { has: ['passTypeIdentifier', 'certSha256', 'apnsHealth'], value: IDENTITY },
  { has: ['kind', 'targetType', 'targetId', 'attempt'], value: IDENTITY_RUN },
  { has: ['state', 'bytes', 'entities'], value: EXPORT },
  { has: ['templateName', 'orgName', 'inWallet'], value: MY_PASS },
  { has: ['endpointId', 'headers', 'trigger'], value: CAPTURE },
  { has: ['apiVersion', 'pass', 'data', 'type'], value: DELIVERY.payload },
  { has: ['placeNames', 'rev', 'serverNow', 'counts'], value: ROLL_CALL },
  { has: ['system', 'use', 'perPass', 'bindingDays'], value: TAG_TYPE },
  { has: ['diversify', 'perTag', 'versions'], value: KEYSET },
  { has: ['contentHash', 'candidateHash', 'adapterRevision'], value: CANDIDATE },
  { has: ['generation', 'candidateHash', 'previousReleaseId'], value: RELEASE_ROW },
  { has: ['assets', 'report', 'displayOnly', 'passJson'], value: TEMPLATE_VERSION },
  { has: ['opensAt', 'closesAt', 'reentry', 'arrived'], value: SCAN_EVENT },
];
