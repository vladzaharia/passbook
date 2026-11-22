import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMockWallets } from '../test/mock-wallets/index.ts';
import { recordGoogleMessages, scrub } from './record-google-messages.ts';

it('scrubs issuer ids, ids and addresses', () => {
  expect(
    scrub({
      id: '3388000000022334455.abc',
      error: { message: 'bot@x.iam.gserviceaccount.com 3388000000022334455' },
    }),
  ).toEqual({ id: '<id>', error: { message: '<email> <issuer>' } });
});

it('records V1 to V5 against the mock, with the fourth notification as the quota fixture', async () => {
  const mock = createMockWallets();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    return mock.handle(new Request(`http://mock.test${url.pathname}`, init));
  }) as typeof fetch;
  // The mock wants a minted token and stored objects; seed both the way the REST client would.
  const tokenRes = await mock.handle(
    new Request('http://mock.test/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${btoa('{}')}.${btoa(JSON.stringify({ scope: 'https://www.googleapis.com/auth/wallet_object.issuer', iss: 'a' }))}.y`,
      }),
    }),
  );
  const minted = ((await tokenRes.json()) as { access_token: string }).access_token;
  const auth = { authorization: `Bearer ${minted}`, 'content-type': 'application/json' };
  for (const id of ['1.cls'])
    await mock.handle(
      new Request('http://mock.test/walletobjects/v1/genericClass', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ id }),
      }),
    );
  for (const id of ['1.a', '1.b'])
    await mock.handle(
      new Request('http://mock.test/walletobjects/v1/genericObject', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ id, classId: '1.cls' }),
      }),
    );
  const out = mkdtempSync(join(tmpdir(), 'gm2-'));
  const steps = await recordGoogleMessages({
    fetcher,
    token: minted,
    objects: ['1.a', '1.b'],
    out,
  });
  expect(steps.find((s) => s.step === 'V1 notify 4')?.status).toBe(429);
  expect(steps.find((s) => s.step === 'V2 other object')?.status).toBe(200);
  expect(JSON.parse(readFileSync(join(out, 'add-message-quota.json'), 'utf8'))).toMatchObject({
    status: 429,
  });
});
