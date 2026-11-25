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

/** Every POST and PATCH whose example body names a template or carries template `input`. */
const examples: { id: string; method: string; path: string; body: Dict }[] = [];
const requests = new Map<string, Dict>();
for (const file of Object.values(refs))
  for (const [id, entry] of Object.entries(file))
    if (isDict(entry.request)) requests.set(id, entry.request);
for (const [path, item] of Object.entries(openapi.paths as Record<string, Dict>))
  for (const [method, op] of Object.entries(item)) {
    const id = isDict(op) ? op.operationId : undefined;
    const body = typeof id === 'string' ? requests.get(id) : undefined;
    if (!body || (method !== 'post' && method !== 'patch')) continue;
    const input = body.input;
    // The scanner's `input` is a scanned code, not template input.
    const templated =
      body.templateId === EXAMPLE_IDS.templateId || (isDict(input) && !('code' in input));
    if (templated) examples.push({ id: id as string, method: method.toUpperCase(), path, body });
  }
// Posting a pass comes first: the pass it makes is the one the others change.
examples.sort(
  (a, b) => Number(b.id === 'passes.postPasses') - Number(a.id === 'passes.postPasses'),
);

/** Google and Samsung ship dark: the reissue route answers WALLET_PROVIDER_DISABLED until a provider is released. */
const DARK = new Set(['wallet-providers.postWalletProvidersReissue']);

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
  Object.assign(kit.env, {
    PASS_IMPORT: { create: async (o: { id: string }) => ({ id: o.id }) },
  });
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

describe('reference examples in a fresh sandbox', () => {
  it('finds the examples that take a template or its input', () => {
    expect(examples.map((e) => e.id)).toEqual(
      expect.arrayContaining(['passes.postPasses', 'passes.patchPassesById']),
    );
  });

  it.each(examples.filter((e) => !DARK.has(e.id)))('$id answers 2xx', async (e) => {
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

  it('the copied curl for Create a pass answers 201', async () => {
    const sh = Object.entries(curls).find(([f]) => f.endsWith('/passes.postPasses.sh'))?.[1] ?? '';
    const body = /-d '([\s\S]*)'$/.exec(sh.trim())?.[1];
    expect(body).toBeDefined();
    const res = await call('POST', '/api/v1/passes', body as string);
    expect(res.status, await res.clone().text()).toBe(201);
  });
});
