import { generateKeyPairSync, sign } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { e2ePorts } from '../tools/lib/e2e-ports.ts';

// Google and Samsung issuance is dark in the Worker (provider-policy.ts), so no issued pass can
// reach a save link yet. This covers the provider layer against the fake server that
// tools/e2e-server.ts starts: the REST calls the runtime makes, then a browser opening the save
// link. test/mock-wallets/mock-wallets.test.ts drives the real client code against the same fake.
const mock = `http://localhost:${e2ePorts.wallets}`;
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';

interface MockState {
  google: {
    genericClass: Record<string, unknown>;
    genericObject: Record<string, { classId: string }>;
    saves: { objectIds: string[] }[];
  };
  samsung: { refs: Record<string, { state: string }> };
}

const b64u = (value: object | Buffer) =>
  Buffer.from(value instanceof Buffer ? value : JSON.stringify(value)).toString('base64url');

function signJwt(claims: object, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) {
  const input = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(claims)}`;
  return `${input}.${b64u(sign('sha256', Buffer.from(input), privateKey))}`;
}

test.beforeEach(async ({ request }) => {
  await request.post(`${mock}/__mock/reset`);
});

test('a Google object is inserted and the save link opens in a browser', async ({
  page,
  request,
}) => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const iat = Math.floor(Date.now() / 1000);
  const tokenResponse = await request.post(`${mock}/token`, {
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(
        { iss: 'e2e@example.iam.gserviceaccount.com', scope: SCOPE, iat, exp: iat + 300 },
        privateKey,
      ),
    },
  });
  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const api = `${mock}/walletobjects/v1`;
  const classId = '3388000000022334455.e2e-class';
  const objectId = '3388000000022334455.e2e-object';

  const classInsert = await request.post(`${api}/genericClass`, { headers, data: { id: classId } });
  expect(classInsert.status()).toBe(200);
  const objectInsert = await request.post(`${api}/genericObject`, {
    headers,
    data: { id: objectId, classId, state: 'ACTIVE' },
  });
  expect(objectInsert.status()).toBe(200);
  expect(
    (
      await request.post(`${api}/genericObject`, { headers, data: { id: objectId, classId } })
    ).status(),
  ).toBe(409);

  const saveJwt = signJwt(
    {
      iss: 'e2e@example.iam.gserviceaccount.com',
      aud: 'google',
      typ: 'savetowallet',
      iat,
      payload: { genericObjects: [{ id: objectId }] },
    },
    privateKey,
  );
  await page.goto(`${mock}/gp/v/save/${saveJwt}`);
  await expect(page.getByText('Saved to Google Wallet (mock).')).toBeVisible();

  const state = (await (await request.get(`${mock}/__mock/state`)).json()) as MockState;
  expect(state.google.genericObject[objectId]?.classId).toBe(classId);
  expect(state.google.saves).toEqual([expect.objectContaining({ objectIds: [objectId] })]);
});

test('a Samsung update is recorded and an injected failure is returned once', async ({
  request,
}) => {
  const headers = { authorization: 'Bearer e2e', 'x-smcs-partner-id': 'e2e-partner' };
  const update = { card: { type: 'ticket', data: [{ refId: 'ref1', state: 'EXPIRED' }] } };
  const url = `${mock}/US/wltex/cards/card1/updates`;

  await request.post(`${mock}/__mock/inject`, { data: { status: 429, match: '/updates' } });
  expect((await request.post(url, { headers, data: update })).status()).toBe(429);
  expect((await request.post(url, { headers, data: update })).status()).toBe(200);

  const state = (await (await request.get(`${mock}/__mock/state`)).json()) as MockState;
  expect(state.samsung.refs.ref1?.state).toBe('EXPIRED');
});

// Why this stops at the provider layer: the broadcast to a saved Google pass and the sync-log row cannot run in e2e.
// ENABLED.google in provider-policy.ts is a code constant that only the in-process test setter changes, and the e2e
// server is another process with no Google account or release, so lighting issuance here would mean changing the
// production flag. The send path runs end to end against this same mock in the worker tests
// (sync-operation-google-messages.test.ts), and the "Wallet message" row is covered by sync-model.test.ts.
test('a Google change message lands on the object, and a fourth notification in a day is refused', async ({
  request,
}) => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const iat = Math.floor(Date.now() / 1000);
  const { access_token: accessToken } = (await (
    await request.post(`${mock}/token`, {
      form: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(
          { iss: 'e2e@example.iam.gserviceaccount.com', scope: SCOPE, iat, exp: iat + 300 },
          privateKey,
        ),
      },
    })
  ).json()) as { access_token: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const api = `${mock}/walletobjects/v1`;
  const classId = '3388000000022334455.e2e-class';
  const objectId = '3388000000022334455.e2e-object';
  await request.post(`${api}/genericClass`, { headers, data: { id: classId } });
  await request.post(`${api}/genericObject`, { headers, data: { id: objectId, classId } });

  const message = (id: string, messageType: string) => ({
    message: { id, header: 'Club', body: 'Tier is now Gold', messageType },
  });
  const url = `${api}/genericObject/${encodeURIComponent(objectId)}/addMessage`;
  for (const id of ['m1', 'm2', 'm3'])
    expect(
      (await request.post(url, { headers, data: message(id, 'TEXT_AND_NOTIFY') })).status(),
    ).toBe(200);
  const refused = await request.post(url, { headers, data: message('m4', 'TEXT_AND_NOTIFY') });
  expect(refused.status()).toBe(429);
  expect(JSON.stringify(await refused.json())).toContain('QuotaExceeded');
  expect((await request.post(url, { headers, data: message('m5', 'TEXT') })).status()).toBe(200);

  const state = (await (await request.get(`${mock}/__mock/state`)).json()) as {
    google: { genericObject: Record<string, { messages: { id: string; messageType: string }[] }> };
  };
  expect(state.google.genericObject[objectId]?.messages.map((m) => m.id)).toEqual([
    'm1',
    'm2',
    'm3',
    'm5',
  ]);
});
