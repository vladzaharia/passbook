import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import openapi from '../../docs/api/openapi.v1.json';
import { CreatedDeveloperSandboxSchema } from '../../src/shared/contracts/developer.ts';
import { EXAMPLE_IDS } from '../../src/web/developers/model/ids.ts';
import { createApp } from '../../src/worker/app.ts';
import { createApiKeyStore } from '../../src/worker/modules/api-keys/service.ts';
import { createSessionStore } from '../../src/worker/modules/auth/sessions.ts';
import {
  type BlueprintKit,
  blueprintKit,
} from '../../src/worker/modules/templates/blueprint-test-fixtures.ts';
import { denyAllStores } from '../../src/worker/platform/auth.ts';
import { makeSession, makeUser } from '../helpers/index.ts';

// A reader's first Run and copied sample must pass in a fresh sandbox, not in a world built to fit the example.
const ORIGIN = 'https://passbook.mobile';
/** Cloudflare's always-pass test secret: the verifier skips the hostname and action checks. */
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

const refs = import.meta.glob<Record<string, { request?: Record<string, unknown> }>>(
  '../../docs/api/reference/*.json',
  { eager: true, import: 'default' },
);
const curls = import.meta.glob<string>('../../docs/developers/snippets/generated/curl/*.sh', {
  query: '?raw',
  import: 'default',
  eager: true,
});

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);

/** True when `key` appears anywhere in the example, at any depth. */
const deep = (v: unknown, test: (key: string, value: unknown) => boolean): boolean =>
  Array.isArray(v)
    ? v.some((x) => deep(x, test))
    : isDict(v) && Object.entries(v).some(([k, x]) => test(k, x) || deep(x, test));

/** The scanner's `input` is a scanned code, not template input. */
const SCAN_INPUT = new Set(['scan.postScanResolve', 'scan.postScanActions']);

/** Every POST and PATCH whose example names a template (`templateId`, `templateIds`) or carries an `input` object. */
const examples: { id: string; method: string; path: string; body: Dict }[] = [];
const requests = new Map<string, Dict>();
for (const file of Object.values(refs))
  for (const [id, entry] of Object.entries(file))
    if (isDict(entry.request)) requests.set(id, entry.request);
for (const [path, item] of Object.entries(openapi.paths as Record<string, Dict>))
  for (const [method, op] of Object.entries(item)) {
    const id = isDict(op) ? op.operationId : undefined;
    const body = typeof id === 'string' ? requests.get(id) : undefined;
    if (!body || (method !== 'post' && method !== 'patch') || SCAN_INPUT.has(id as string))
      continue;
    if (
      deep(
        body,
        (k, v) => k === 'templateId' || k === 'templateIds' || (k === 'input' && isDict(v)),
      )
    )
      examples.push({ id: id as string, method: method.toUpperCase(), path, body });
  }
// Posting a pass comes first: the pass it makes is the one the others change.
examples.sort(
  (a, b) => Number(b.id === 'passes.postPasses') - Number(a.id === 'passes.postPasses'),
);

/**
 * Examples that do not fit a fresh sandbox: written for the gym's Day pass (name, tier, validUntil), or needing setup
 * a sandbox lacks. The Day pass ones are R13's to move into the ticket world; until then each is listed here with what it does today, and
 * the test fails when one starts to work, so the entry is removed rather than forgotten.
 */
const KNOWN_R13: Record<string, string> = {
  'message-rules.postMessageRules': 'the rule anchors on the Day pass input `validUntil`',
  'message-rules.postMessageRulesPreview': 'the rule anchors on the Day pass input `validUntil`',
  'passes.postPassesBulkRuns':
    'the example selects 128 passes (`expectCount`); a sandbox has fewer',
  'pass-imports.postPassImports':
    'queues at once, but the CSV columns map to Day pass inputs, so no row imports into the ticket',
  'broadcasts.postBroadcasts':
    'the change is a Day pass `validUntil` patch with a message: the API refuses that mix (VALIDATION)',
  'broadcasts.patchBroadcastsById':
    'the change is a Day pass `validUntil` patch with a message: the API refuses that mix (VALIDATION)',
  'webhooks.postWebhookEndpoints': 'the endpoint URL needs a DNS lookup the test cannot make (500)',
  'scanners.postScanningSessions': 'needs a credential key, which a sandbox key cannot be (401)',
  'scan-events.postScanEvents':
    'scanner devices are not in the sandbox plan (FEATURE_NOT_INCLUDED)',
  'wallet-providers.postWalletProvidersReissue':
    'Google and Samsung ship dark: it answers WALLET_PROVIDER_DISABLED',
};

let kit: BlueprintKit;
let app: ReturnType<typeof createApp>;
let key: string;
let orgId: string;
let templateId: string;
let passId = '';
const realFetch = globalThis.fetch;

beforeAll(async () => {
  kit = await blueprintKit();
  kit.env.TURNSTILE_SECRET = TURNSTILE_TEST_SECRET;
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://challenges.cloudflare.com/'))
      return Response.json({ success: true });
    return realFetch(input, init);
  });
  // The reader's own sandbox, made the way the quickstart makes it.
  const user = await makeUser(kit.f);
  const session = await makeSession(kit.f, { userId: user.id, roles: ['user', 'developer'] });
  const res = await app.request(
    `${ORIGIN}/api/v1/developer/sandbox`,
    {
      method: 'POST',
      headers: {
        ...session.headers,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      body: JSON.stringify({ turnstileToken: 'ok' }),
    },
    kit.env,
  );
  expect(res.status, await res.clone().text()).toBe(201);
  const made = CreatedDeveloperSandboxSchema.parse(await res.json());
  if (!made.key || !made.templateId) throw new Error('A new sandbox has a key and a template.');
  ({ orgId, templateId } = { orgId: made.orgId, templateId: made.templateId });
  key = made.key.secret;
});
afterAll(() => vi.unstubAllGlobals());

/** The example's ids swapped for the sandbox's, as the portal does for a signed-in reader. */
const personal = (text: string) =>
  text
    .replaceAll(EXAMPLE_IDS.orgId, orgId)
    .replaceAll(EXAMPLE_IDS.templateId, templateId)
    .replaceAll(EXAMPLE_IDS.passId, passId);

const call = (method: string, path: string, body: string) =>
  app.request(
    `${ORIGIN}${personal(path)}`,
    {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'idempotency-key': kit.f.ids.token(),
      },
      body: personal(body),
    },
    kit.env,
  );

/** The examples this test selects: a new one must be added here (and made to work, or listed in KNOWN_R13). */
const PINNED = [
  'broadcasts.patchBroadcastsById',
  'broadcasts.postBroadcasts',
  'broadcasts.postBroadcastsPreview',
  'message-rules.postMessageRules',
  'message-rules.postMessageRulesPreview',
  'pass-imports.postPassImports',
  'passes.patchPassesById',
  'passes.postPasses',
  'passes.postPassesBulkReissue',
  'passes.postPassesBulkRuns',
  'scan-events.postScanEvents',
  'scanners.postScanningSessions',
  'templates.postTemplatesByIdPreview',
  'wallet-providers.postWalletProvidersReissue',
  'webhooks.postWebhookEndpoints',
];

/** What the API says of an example that still does not fit the sandbox: refused, or an import that did not map. */
const stillBroken = (status: number, body: Dict): boolean =>
  status >= 400 ||
  body.state === 'mapping' ||
  (Array.isArray(body.problems) && body.problems.length > 0);

describe('reference examples in a fresh sandbox', () => {
  it('selects exactly these examples', () => {
    expect(examples.map((e) => e.id).sort()).toEqual(PINNED);
  });

  it.each(examples.filter((e) => !(e.id in KNOWN_R13)))('$id answers 2xx', async (e) => {
    const path = e.path.replace('{id}', e.id.startsWith('templates.') ? templateId : passId);
    const res = await call(e.method, path, JSON.stringify(e.body));
    const text = await res.text();
    expect(res.status, `${e.id}: ${text}`).toBeLessThan(300);
    expect(res.status).toBeGreaterThanOrEqual(200);
    if (e.id === 'passes.postPasses') {
      expect(res.status).toBe(201);
      passId = (JSON.parse(text) as { id: string }).id;
    }
  });

  it.each(examples.filter((e) => e.id in KNOWN_R13).map((e) => [e.id, KNOWN_R13[e.id]] as const))(
    'known gap %s: %s',
    async (id) => {
      const e = examples.find((x) => x.id === id) as (typeof examples)[number];
      const res = await call(e.method, e.path.replace('{id}', passId), JSON.stringify(e.body));
      const body = (await res.json().catch(() => ({}))) as Dict;
      expect(stillBroken(res.status, body), `${id} now works: remove it from KNOWN_R13`).toBe(true);
    },
  );

  it('keeps every known gap tied to a selected example', () => {
    expect(Object.keys(KNOWN_R13).filter((id) => !examples.some((e) => e.id === id))).toEqual([]);
  });

  it('the copied curl for Create a pass answers 201', async () => {
    const sh = Object.entries(curls).find(([f]) => f.endsWith('/passes.postPasses.sh'))?.[1] ?? '';
    const body = /-d '([\s\S]*)'$/.exec(sh.trim())?.[1];
    expect(body).toBeDefined();
    const res = await call('POST', '/api/v1/passes', body as string);
    expect(res.status, await res.clone().text()).toBe(201);
  });
});
