import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GoogleValidatedAccount } from '../../src/worker/modules/wallet-providers/google-credentials.ts';
import {
  GOOGLE_WALLET_SCOPE,
  validateGoogleAccount,
} from '../../src/worker/modules/wallet-providers/google-credentials.ts';
import { GoogleWalletError } from '../../src/worker/modules/wallet-providers/google-errors.ts';
import { getGoogleAccessToken } from '../../src/worker/modules/wallet-providers/google-oauth.ts';
import { createGoogleSaveOffer } from '../../src/worker/modules/wallet-providers/google-offer.ts';
import {
  clearGoogleRestMemo,
  type GoogleWalletRestContext,
  upsertGoogleGenericClass,
  upsertGoogleGenericObject,
} from '../../src/worker/modules/wallet-providers/google-rest.ts';
import { addGoogleObjectMessage } from '../../src/worker/modules/wallet-providers/google-rest-typed.ts';
import { mockProviderInput } from '../../src/worker/modules/wallet-providers/mock-endpoint.ts';
import { createMockWallets } from './index.ts';

const env = {
  WALLET_MOCK_PROVIDERS_URL: 'http://localhost:5175',
  PUBLIC_BASE_URL: 'http://localhost:5173',
};
const secret = new Uint8Array(32).fill(7);
const scope = {
  tenantId: 'tenant',
  releaseId: 'release',
  passId: 'pass',
  mode: 'test' as const,
  credentialGeneration: 1,
  channelEpoch: 1,
};
const projection = {
  cardTitle: { defaultValue: { language: 'en', value: 'Club' } },
  header: { defaultValue: { language: 'en', value: 'Member' } },
  state: 'ACTIVE',
} as const;

let account: GoogleValidatedAccount;
let mock: ReturnType<typeof createMockWallets>;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...der))
    .match(/.{1,64}/g)
    ?.join('\n');
  account = await validateGoogleAccount({
    issuerId: '3388000000022334455',
    serviceAccountEmail: 'svc@example.iam.gserviceaccount.com',
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`,
    scopes: [GOOGLE_WALLET_SCOPE],
  });
});

beforeEach(() => {
  mock = createMockWallets();
  clearGoogleRestMemo();
});

/** What the Worker's runtime fetcher does in dev: rewrite, then send (workerd's Request lacks redirect "error"). */
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { redirect: _redirect, ...rest } = init ?? {};
  return mock.handle(new Request(mockProviderInput(env, input), rest));
}) as typeof fetch;

async function rest(): Promise<GoogleWalletRestContext> {
  const token = await getGoogleAccessToken(account, { issuedAt: 1_700_000_000, fetcher });
  return { account, objectIdHmacKey: secret, accessToken: token.accessToken, fetcher };
}

describe('mock Google Wallet with the real client code', () => {
  it('mints a token, inserts a class and object, and records the save link', async () => {
    const ctx = await rest();
    expect(await upsertGoogleGenericClass(ctx, scope, projection)).toBe('created');
    expect(await upsertGoogleGenericObject(ctx, scope, projection)).toBe('created');
    expect(mock.google.genericClass.size).toBe(1);
    expect(mock.google.genericObject.size).toBe(1);

    const offer = await createGoogleSaveOffer(account, secret, scope, {
      origins: ['http://localhost:5173'],
      issuedAt: 1_700_000_000,
    });
    const opened = await fetcher(offer.url);
    expect(opened.status).toBe(200);
    expect(mock.saves).toHaveLength(1);
    expect([...mock.google.genericObject.keys()]).toEqual(mock.saves[0]?.objectIds);
  });

  it('upserts an existing resource through the 409 then GET then PATCH path', async () => {
    const ctx = await rest();
    await upsertGoogleGenericClass(ctx, scope, projection);
    clearGoogleRestMemo();
    expect(await upsertGoogleGenericClass(ctx, scope, { ...projection, state: 'INACTIVE' })).toBe(
      'updated',
    );
    const [doc] = [...mock.google.genericClass.values()];
    expect(doc?.state).toBe('INACTIVE');
  });

  it('refuses a save link for an object that was never inserted', async () => {
    const offer = await createGoogleSaveOffer(account, secret, scope, {
      origins: ['http://localhost:5173'],
      issuedAt: 1_700_000_000,
    });
    expect((await fetcher(offer.url)).status).toBe(404);
    expect(mock.saves).toHaveLength(0);
  });

  it('rejects an unknown bearer token with 401', async () => {
    const ctx = { ...(await rest()), accessToken: 'never-minted' };
    await expect(upsertGoogleGenericClass(ctx, scope, projection)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('object addMessage', () => {
  const message = (id: string, messageType: 'TEXT' | 'TEXT_AND_NOTIFY') => ({
    id,
    header: 'Club',
    body: 'Tier is now Gold',
    messageType,
  });
  async function seeded() {
    const ctx = await rest();
    await upsertGoogleGenericClass(ctx, scope, projection);
    await upsertGoogleGenericObject(ctx, scope, projection);
    return ctx;
  }

  it('appends the message to the object and counts notifications per object', async () => {
    const ctx = await seeded();
    await addGoogleObjectMessage(ctx, 'generic', scope, message('m1', 'TEXT_AND_NOTIFY'));
    await addGoogleObjectMessage(ctx, 'generic', scope, message('m2', 'TEXT'));
    const [object] = [...mock.google.genericObject.values()];
    expect(object?.messages).toMatchObject([{ id: 'm1' }, { id: 'm2' }]);
    expect([...mock.notifications.values()].map((t) => t.length)).toEqual([1]);
  });

  it('refuses the fourth notification in 24 hours as a quota error, and a plain 429 stays rate limiting', async () => {
    const ctx = await seeded();
    for (const id of ['a', 'b', 'c'])
      await addGoogleObjectMessage(ctx, 'generic', scope, message(id, 'TEXT_AND_NOTIFY'));
    await expect(
      addGoogleObjectMessage(ctx, 'generic', scope, message('d', 'TEXT_AND_NOTIFY')),
    ).rejects.toMatchObject({ code: 'quota_exceeded', status: 429 });
    mock.failNext({ status: 429, match: 'addMessage' });
    await expect(
      addGoogleObjectMessage(ctx, 'generic', scope, message('e', 'TEXT')),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('refuses an eleventh message and an object that is not there', async () => {
    const ctx = await seeded();
    for (let i = 0; i < 10; i++)
      await addGoogleObjectMessage(ctx, 'generic', scope, message(`t${i}`, 'TEXT'));
    await expect(
      addGoogleObjectMessage(ctx, 'generic', scope, message('t10', 'TEXT')),
    ).rejects.toMatchObject({ code: 'bad_request' });
    mock.reset();
    await expect(
      addGoogleObjectMessage(await rest(), 'generic', scope, message('x', 'TEXT')),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('failure injection', () => {
  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [503, 'server_error'],
  ])('fails the next matching call with %i', async (status, code) => {
    const ctx = await rest();
    mock.failNext({ status, match: 'POST /walletobjects/v1/genericClass', retryAfterSeconds: 7 });
    const error = await upsertGoogleGenericClass(ctx, scope, projection).catch((e) => e);
    expect(error).toBeInstanceOf(GoogleWalletError);
    expect(error.code).toBe(code);
    if (status === 429 || status === 503) expect(error.retryAfterMs).toBe(7000);
    // The rule is spent: the retry succeeds.
    expect(await upsertGoogleGenericClass(ctx, scope, projection)).toBe('created');
    expect(mock.requests.filter((r) => r.injected)).toHaveLength(1);
  });

  it('injects a 409 that the client resolves by checking identity', async () => {
    const ctx = await rest();
    await upsertGoogleGenericClass(ctx, scope, projection);
    clearGoogleRestMemo();
    mock.failNext({ status: 409, match: 'POST /walletobjects/v1/genericClass' });
    expect(await upsertGoogleGenericClass(ctx, scope, projection)).toBe('updated');
  });

  it('refuses an invalid inject regex with a 400', async () => {
    const response = await mock.handle(
      new Request('http://localhost:5175/__mock/inject', {
        method: 'POST',
        body: JSON.stringify({ status: 500, match: '(' }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('regular') });
  });

  it('honours times and over the control endpoints', async () => {
    const call = (path: string, init?: RequestInit) =>
      mock.handle(new Request(`http://localhost:5175${path}`, init));
    await call('/__mock/inject', {
      method: 'POST',
      body: JSON.stringify({ status: 500, times: 2, match: 'token' }),
    });
    const token = () =>
      call('/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=x',
      });
    expect((await token()).status).toBe(500);
    expect((await token()).status).toBe(500);
    expect((await token()).status).toBe(400);
    const log = (await (await call('/__mock/requests')).json()) as { injected: boolean }[];
    expect(log.map((r) => r.injected)).toEqual([true, true, false]);
    await call('/__mock/reset', { method: 'POST' });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('mock Samsung Wallet', () => {
  const headers = { authorization: 'Bearer t', 'x-smcs-partner-id': 'p1' };
  const post = (path: string, body: unknown, h: Record<string, string> = headers) =>
    mock.handle(
      new Request(`http://localhost:5175${path}`, {
        method: 'POST',
        headers: { ...h, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('records ref updates and event cancellations', async () => {
    const update = await post('/US/wltex/cards/c1/updates', {
      card: { type: 'ticket', data: [{ refId: 'r1', state: 'EXPIRED' }] },
    });
    expect(update.status).toBe(200);
    expect(mock.samsungRefs.get('r1')).toEqual({ type: 'ticket', state: 'EXPIRED', cardId: 'c1' });
    await post('/US/wltex/cards/c1/cancels', {
      card: { type: 'ticket', data: [{ eventId: 'e1', state: 'CANCELED' }] },
    });
    expect(mock.samsungCancels).toEqual([{ cardId: 'c1', eventId: 'e1' }]);
  });

  it('serves the card template and refuses unsigned calls', async () => {
    mock.setSamsungTemplate('c1', {
      cardType: 'coupon',
      subType: 'others',
      countryCode: 'DE',
      state: 'ACTIVE',
      testingModeOff: 'N',
    });
    const response = await mock.handle(
      new Request('http://localhost:5175/partner/v1/card/template/c1', { headers }),
    );
    expect(await response.json()).toMatchObject({
      resultCode: '0',
      template: { cardId: 'c1', cardType: 'coupon', testingModeOff: 'N' },
    });
    expect((await post('/US/wltex/cards/c1/updates', {}, {})).status).toBe(401);
  });

  it('injects Samsung failures too', async () => {
    mock.failNext({ status: 204, match: '/updates' });
    expect((await post('/US/wltex/cards/c1/updates', { card: { data: [] } })).status).toBe(204);
    expect(mock.requests[0]).toMatchObject({ provider: 'samsung', injected: true });
  });
});

describe("mock Google's callback keys", () => {
  const keys = () => mock.handle(new Request('http://localhost:5175/gp/m/issuer/keys'));
  const setKeys = (body: unknown) =>
    mock.handle(
      new Request('http://localhost:5175/__mock/google-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('serves no key until a test sets them, then the keys it set', async () => {
    expect(await (await keys()).json()).toEqual({ keys: [] });
    const set = [{ protocolVersion: 'ECv2SigningOnly', keyValue: 'a', keyExpiration: '1' }];
    expect((await setKeys({ keys: set })).status).toBe(200);
    expect(await (await keys()).json()).toEqual({ keys: set });
  });

  it('refuses keys that are not a list, and forgets them on reset', async () => {
    expect((await setKeys({ keys: 'a' })).status).toBe(400);
    await setKeys({ keys: [{ keyValue: 'a' }] });
    mock.reset();
    expect(await (await keys()).json()).toEqual({ keys: [] });
  });

  it('logs the keys download as a Google request', async () => {
    mock.reset();
    await keys();
    expect(mock.requests[0]).toMatchObject({
      provider: 'google',
      method: 'GET',
      path: '/gp/m/issuer/keys',
      status: 200,
    });
  });
});
