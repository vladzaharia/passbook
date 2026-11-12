import { describe, expect, it } from 'vitest';
import { GOOGLE_WALLET_SCOPE, type GoogleValidatedAccount } from './google-credentials.ts';
import { googleObjectIds } from './google-ids.ts';
import type { GoogleGenericProjection } from './google-projection.ts';
import {
  type GoogleWalletRestContext,
  inactivateGoogleGenericObject,
  patchGoogleGenericClass,
  patchGoogleGenericObject,
  upsertGoogleGenericClass,
  upsertGoogleGenericObject,
} from './google-rest.ts';

const account: GoogleValidatedAccount = {
  issuerId: '33880000000223344',
  serviceAccountEmail: 'service@example.iam.gserviceaccount.com',
  scopes: [GOOGLE_WALLET_SCOPE],
  signingKey: {} as CryptoKey,
};
const secret = new Uint8Array(32).fill(5);
const scope = {
  tenantId: 'tenant-a',
  releaseId: 'release-a',
  passId: 'pass-a',
  mode: 'live' as const,
  credentialGeneration: 1,
};
const objectProjection = {
  cardTitle: { defaultValue: { language: 'en', value: 'Club' } },
  header: { defaultValue: { language: 'en', value: 'Membership' } },
  state: 'ACTIVE',
} satisfies GoogleGenericProjection;
const base = 'https://walletobjects.googleapis.com/walletobjects/v1';

type RequestCapture = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  redirect: string | undefined;
};

function setup(replies: Response[]) {
  const calls: RequestCapture[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? '',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      redirect: init?.redirect,
    });
    const response = replies.shift();
    if (!response) throw new Error('Unexpected request');
    return response;
  }) as typeof fetch;
  const ctx: GoogleWalletRestContext = {
    account,
    objectIdHmacKey: secret,
    accessToken: 'ya29.secret-token',
    fetcher,
  };
  return { calls, ctx };
}

const ok = () => Response.json({});
const conflict = () => new Response('potentially sensitive provider details', { status: 409 });

describe('Google Wallet class REST operations', () => {
  it('creates a class with derived identity and authenticates requests', async () => {
    const { calls, ctx } = setup([ok()]);
    const result = await upsertGoogleGenericClass(ctx, scope, { enableSmartTap: false });
    const ids = await googleObjectIds(account.issuerId, secret, scope);
    expect(result).toBe('created');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `${base}/genericClass`,
      method: 'POST',
      redirect: 'error',
      body: { id: ids.classId, enableSmartTap: false },
    });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer ya29.secret-token');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('confirms the class after conflict and requires an actual successful PATCH', async () => {
    const { classId } = await googleObjectIds(account.issuerId, secret, scope);
    const { calls, ctx } = setup([conflict(), Response.json({ id: classId }), ok()]);
    expect(await upsertGoogleGenericClass(ctx, scope, { enableSmartTap: true })).toBe('updated');
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', `${base}/genericClass`],
      ['GET', `${base}/genericClass/${classId}`],
      ['PATCH', `${base}/genericClass/${classId}`],
    ]);
    expect(calls[2]?.body).toEqual({ enableSmartTap: true });
  });

  it('does not treat a conflict, missing resource, or failed patch as success', async () => {
    const { classId } = await googleObjectIds(account.issuerId, secret, scope);
    const missing = setup([conflict(), new Response('', { status: 404 })]);
    await expect(upsertGoogleGenericClass(missing.ctx, scope, {})).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    const failed = setup([
      conflict(),
      Response.json({ id: classId }),
      new Response('internal details', { status: 500 }),
    ]);
    await expect(upsertGoogleGenericClass(failed.ctx, scope, {})).rejects.toMatchObject({
      code: 'server_error',
      status: 500,
    });
    const wrong = setup([conflict(), Response.json({ id: 'other-class' })]);
    await expect(upsertGoogleGenericClass(wrong.ctx, scope, {})).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(wrong.calls).toHaveLength(2);
  });

  it('patches an existing class and rejects supplied identity overrides', async () => {
    const { calls, ctx } = setup([ok()]);
    const { classId } = await googleObjectIds(account.issuerId, secret, scope);
    await patchGoogleGenericClass(ctx, scope, { enableSmartTap: false });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `${base}/genericClass/${classId}`,
      body: { enableSmartTap: false },
    });
    const malicious = { id: 'other', enableSmartTap: false } as unknown as GoogleGenericProjection;
    await expect(patchGoogleGenericClass(ctx, scope, malicious)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('Google Wallet object REST operations', () => {
  it('creates the object with derived issuer, class, and object IDs', async () => {
    const { calls, ctx } = setup([ok()]);
    const ids = await googleObjectIds(account.issuerId, secret, scope);
    expect(await upsertGoogleGenericObject(ctx, scope, objectProjection)).toBe('created');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${base}/genericObject`,
      body: { ...objectProjection, id: ids.objectId, classId: ids.classId },
    });
  });

  it('creates a distinct new-holder object and retires only the original generation', async () => {
    const old = await googleObjectIds(account.issuerId, secret, scope);
    const nextScope = { ...scope, credentialGeneration: scope.credentialGeneration + 1 };
    const next = await googleObjectIds(account.issuerId, secret, nextScope);
    const { calls, ctx } = setup([
      ok(),
      Response.json({ id: old.objectId, classId: old.classId }),
      ok(),
    ]);
    await upsertGoogleGenericObject(ctx, nextScope, objectProjection);
    await inactivateGoogleGenericObject(ctx, scope);
    expect(next.objectId).not.toBe(old.objectId);
    expect(calls[0]?.body).toMatchObject({ id: next.objectId });
    expect(calls[1]).toMatchObject({ method: 'GET', url: `${base}/genericObject/${old.objectId}` });
    expect(calls[2]).toMatchObject({
      method: 'PATCH',
      url: `${base}/genericObject/${old.objectId}`,
      body: { state: 'INACTIVE' },
    });
  });

  it('handles object conflicts idempotently but never infers installation from object state', async () => {
    const { classId, objectId } = await googleObjectIds(account.issuerId, secret, scope);
    const { calls, ctx } = setup([
      conflict(),
      Response.json({ id: objectId, classId, state: 'ACTIVE', hasUsers: true }),
      ok(),
    ]);
    const result = await upsertGoogleGenericObject(ctx, scope, objectProjection);
    expect(result).toBe('updated');
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET', 'PATCH']);
    expect(calls[2]).toMatchObject({
      url: `${base}/genericObject/${objectId}`,
      body: objectProjection,
    });
    expect(typeof result).toBe('string');
    expect(result).not.toBe('installed');
  });

  it('rejects a release upgrade that attempts to rebind the existing object to another class', async () => {
    const { objectId, classId } = await googleObjectIds(account.issuerId, secret, scope);
    const upgraded = { ...scope, releaseId: 'release-b' };
    const { calls, ctx } = setup([conflict(), Response.json({ id: objectId, classId })]);
    await expect(upsertGoogleGenericObject(ctx, upgraded, objectProjection)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(calls).toHaveLength(2);
  });

  it('checks class identity before updating, then sends only the approved patch', async () => {
    const { classId, objectId } = await googleObjectIds(account.issuerId, secret, scope);
    const { calls, ctx } = setup([Response.json({ id: objectId, classId }), ok()]);
    await patchGoogleGenericObject(ctx, scope, { textModulesData: [{ id: 'm', body: 'changed' }] });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]).toMatchObject({
      url: `${base}/genericObject/${objectId}`,
      body: { textModulesData: [{ id: 'm', body: 'changed' }] },
    });
  });

  it('inactivates an identity-checked object without interpreting its previous state', async () => {
    const { classId, objectId } = await googleObjectIds(account.issuerId, secret, scope);
    const { calls, ctx } = setup([
      Response.json({ id: objectId, classId, state: 'INACTIVE' }),
      ok(),
    ]);
    expect(await inactivateGoogleGenericObject(ctx, scope)).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]).toMatchObject({
      url: `${base}/genericObject/${objectId}`,
      body: { state: 'INACTIVE' },
    });
    const absent = setup([new Response('missing', { status: 404 })]);
    await expect(inactivateGoogleGenericObject(absent.ctx, scope)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(absent.calls).toHaveLength(1);
  });

  it('rejects object/class ID overrides before making a request', async () => {
    const { calls, ctx } = setup([]);
    for (const input of [
      { ...objectProjection, id: 'foreign' },
      { ...objectProjection, classId: 'foreign' },
      { toJSON: () => ({ id: 'foreign' }) },
      { toJSON: () => ({ classId: 'foreign' }) },
    ]) {
      const malicious = input as unknown as GoogleGenericProjection;
      await expect(upsertGoogleGenericObject(ctx, scope, malicious)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('Google Wallet REST error handling', () => {
  it.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
  ])('classifies HTTP %i without exposing response details', async (status, code) => {
    const sensitive = 'private-holder-data-in-provider-body';
    const { ctx } = setup([new Response(sensitive, { status })]);
    try {
      await patchGoogleGenericClass(ctx, scope, {});
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain(sensitive);
      expect(JSON.stringify(error)).not.toContain('ya29.secret-token');
    }
  });

  it('rejects unsafe bearer values and sanitizes network exceptions', async () => {
    const { calls, ctx } = setup([]);
    await expect(
      patchGoogleGenericClass({ ...ctx, accessToken: 'bad\r\nheader' }, scope, {}),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toHaveLength(0);
    const leak = 'sensitive-request-url-and-token';
    const fetcher = (async () => {
      throw new Error(leak);
    }) as typeof fetch;
    try {
      await patchGoogleGenericClass({ ...ctx, fetcher }, scope, {});
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'network' });
      expect(String(error)).not.toContain(leak);
    }
  });
});
