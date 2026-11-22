// Hand-written parts of examples, by `<operationId> <request|response>`: what the call says, in the world's terms.
// A seed is a partial value; the sampler fits it to the schema and fills the rest (example-sampler.ts).
import {
  API_KEY,
  BROADCAST,
  IMPORT_ROWS,
  KEY_ACTIVITY,
  localHour,
  MESSAGE_RULE,
  RELEASE,
  RULE_RUN,
  SCAN_EVENT,
  SCAN_INPUT,
  VISITOR,
  WEBHOOK_ENDPOINT,
  WEBHOOK_SECRET,
} from './example-canon.ts';
import { hex, IDS, IMPORT, PASS, T, TEMPLATE } from './example-world.ts';

const uuid = (seed: string): string => `0193a1b2-7c00-7000-8000-${hex(seed, 12)}`;
const GRACE = uuid('pass-grace');
const scope = { orgId: IDS.org, eventId: IDS.event, timeZone: 'America/Los_Angeles' };
const scanRequest = {
  idempotencyKey: uuid('idem-scan'),
  input: SCAN_INPUT,
  clientTs: T.recent,
  dayStart: localHour(0),
  scope,
};

const MIN = 60_000;
/** The pass after a call that changed it: one version on, modified now. */
const changed = (fields: Record<string, unknown>, version = 2) => ({
  ...PASS,
  ...fields,
  version,
  modifiedAt: T.now,
});

/** The members import before anyone committed it: checked, every row planned. */
const READY = {
  ...IMPORT,
  state: 'ready',
  committedAt: null,
  finishedAt: null,
  emailHoldUntil: null,
  progress: null,
};

export const SEEDS: Record<string, unknown> = {
  'pass-imports.postPassImports response': READY,
  'pass-imports.postPassImportsByIdCheck response': READY,
  'pass-imports.postPassImportsByIdCommit request': { skipInvalid: false, email: true },
  'pass-imports.postPassImportsByIdCommit response': {
    ...IMPORT,
    state: 'committing',
    finishedAt: null,
    progress: { ...IMPORT.progress, done: 1, created: 1, updated: 0 },
  },
  'passes.getPasses response': { items: [PASS], nextCursor: 'c1.4812', count: 128 },
  'passes.postPassesByIdVoid response': changed({ status: 'voided' }),
  'passes.postPassesByIdUnvoid response': changed({ status: 'active' }, 3),
  // A removed pass reads as voided, with the time it left Wallet (contracts/passes.ts).
  'passes.postPassesByIdRemove response': changed({ status: 'voided', removedAt: T.now }),
  'passes.postPassesByIdRestore response': changed({ status: 'active' }, 3),
  'passes.patchPassesById response': changed({
    personalization: { ...TEMPLATE.sample, validUntil: '2027-01-31' },
  }),
  'passes.getPassesByIdDevices response': {
    version: 1,
    devices: [
      {
        device: 'iPhone 15',
        status: 'current',
        registeredAt: T.updated + 3 * MIN,
        unregisteredAt: null,
        lastFetch: { at: T.updated + 3 * MIN, version: 1, httpStatus: 200 },
        lastPush: null,
        removal: null,
      },
      {
        device: 'Apple Watch',
        status: 'current',
        registeredAt: T.updated + 4 * MIN,
        unregisteredAt: null,
        lastFetch: { at: T.updated + 4 * MIN, version: 1, httpStatus: 200 },
        lastPush: null,
        removal: null,
      },
    ],
    removal: null,
  },
  'scan.postScanResolve request': scanRequest,
  'scan.postScanActions request': { ...scanRequest, actionId: 'admit' },
  'scan.postScanScansByScanIdUndo request': { idempotencyKey: uuid('idem-undo'), scope },
  'webhooks.postWebhookEndpoints request': {
    url: WEBHOOK_ENDPOINT.url,
    description: WEBHOOK_ENDPOINT.description,
    eventTypes: WEBHOOK_ENDPOINT.eventTypes,
    templateIds: WEBHOOK_ENDPOINT.templateIds,
  },
  'webhooks.postWebhookEndpoints response': {
    endpoint: {
      ...WEBHOOK_ENDPOINT,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastStatus: null,
      secretCreatedAt: T.now,
      createdAt: T.now,
    },
    secret: WEBHOOK_SECRET,
  },
  'webhooks.patchWebhookEndpointsById request': {
    eventTypes: ['pass.issued', 'pass.scanned', 'pass.voided'],
  },
  'webhooks.postWebhookEndpointsByIdTest request': { type: 'pass.issued' },
  'webhooks.postWebhookEndpointsByIdTest response': {
    ok: true,
    status: 200,
    durationMs: 240,
    errorCode: null,
    captureId: null,
  },
  'api-keys.postApiKeys response': {
    ...API_KEY,
    createdAt: T.now,
    lastUsedAt: null,
    lastIpPrefix: null,
    secret: undefined,
  },
  'api-keys.getApiKeys response': { items: [API_KEY], nextCursor: null, revokedCount: 1 },
  'api-keys.postApiKeysByIdRotate request': { overlapHours: 24 },
  'api-keys.postApiKeysMeRotate request': { overlapHours: 24 },
  'api-keys.getApiKeysByIdActivity response': KEY_ACTIVITY,
  'api-keys.postApiKeys request': {
    name: API_KEY.name,
    kind: 'service',
    scopes: API_KEY.scopes,
    mode: 'test',
  },
  'broadcasts.postBroadcasts request': {
    orgId: IDS.org,
    kind: 'message',
    name: BROADCAST.name,
    notify: true,
    send: 'now',
    target: { templateIds: [IDS.template] },
    patch: {},
    message: BROADCAST.message,
  },
  'passes.postPassesBulk request': { action: 'send_email', ids: [IDS.pass, GRACE] },
  'passes.postPassesBulk response': { done: 1, skipped: [{ id: GRACE, code: 'NO_RECIPIENT' }] },
  'passes.postPassesBulkRuns request': {
    action: 'remove',
    message: 'Your day pass was replaced by a monthly membership.',
    selection: { filter: { templateId: IDS.template, status: 'active' }, expectCount: 128 },
  },
  'passes.postPassesByIdRemove request': {
    message: 'Your day pass was replaced by a monthly membership.',
  },
  'passes.patchPassesById request': {
    input: { ...TEMPLATE.sample, validUntil: '2027-01-31' },
    notify: true,
  },
  'visitors.postVisitors request': {
    orgId: IDS.org,
    name: VISITOR.name,
    email: 'jordan@example.com',
    hostName: VISITOR.hostName,
    windowFrom: VISITOR.windowFrom,
    windowUntil: VISITOR.windowUntil,
    note: VISITOR.note,
  },
  'scan-events.postScanEvents request': {
    orgId: IDS.org,
    name: SCAN_EVENT.name,
    templateIds: SCAN_EVENT.templateIds,
    opensAt: SCAN_EVENT.opensAt,
    closesAt: SCAN_EVENT.closesAt,
    timeZone: SCAN_EVENT.timeZone,
    capacity: SCAN_EVENT.capacity,
    note: SCAN_EVENT.note,
  },
  'templates.postTemplatesByIdRelease request': {
    version: '4',
    modes: ['test', 'live'],
    expected: { test: 3, live: 3 },
  },
  'templates.postTemplatesByIdRelease response': RELEASE,
  'templates.postTemplatesByIdPreview request': { version: '3', input: TEMPLATE.sample },
  'templates.postTemplatesByIdPreview response': {
    passJson: TEMPLATE.passJson,
    warnings: [
      {
        severity: 'warning',
        code: 'SLOT_UNUSED',
        message: 'strip.png is not used by generic; left out of the pass.',
        path: 'strip.png',
      },
    ],
    assetBaseUrl: `https://passbook.mobile/api/v1/templates/${IDS.template}/versions/3/assets`,
    assetNames: ['icon.png', 'icon@2x.png', 'logo.png'],
  },
  'templates.postTemplatesByIdReview request': {
    version: '4',
    release: true,
    note: 'Logo and colors match the brand guide.',
  },
  'templates.postTemplatesByIdReleasesRollback request': {
    reason: 'The new logo is cropped on older iPhones.',
  },
  'pass-imports.getPassImportsByIdRows response': IMPORT_ROWS,
  'message-rules.getMessageRulesByIdRuns response': { items: [RULE_RUN], nextCursor: null },
  'message-rules.postMessageRulesByIdTest request': { passId: IDS.pass },
  'message-rules.postMessageRulesByIdTest response': {
    ...RULE_RUN,
    id: uuid('broadcast-rule-test'),
    target: { templateIds: [IDS.template], passIds: [IDS.pass] },
    counts: { targeted: 1, updated: 1, unchanged: 0, overBudget: 0, failed: 0 },
    at: T.now,
    createdAt: T.now,
    startedAt: T.now,
    finishedAt: T.now + 2_000,
  },
  'message-rules.postMessageRules request': {
    orgId: IDS.org,
    name: MESSAGE_RULE.name,
    templateIds: MESSAGE_RULE.templateIds,
    anchor: MESSAGE_RULE.anchor,
    offset: MESSAGE_RULE.offset,
    sendAt: MESSAGE_RULE.sendAt,
    timeZone: MESSAGE_RULE.timeZone,
    message: MESSAGE_RULE.message,
  },
};
