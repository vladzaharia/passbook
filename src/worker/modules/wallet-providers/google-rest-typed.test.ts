// CW9b: typed Google classes and objects against the mock wallet server, with the real client code.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockWallets } from '../../../../test/mock-wallets/index.ts';
import type { GoogleType } from '../../../passkit/wallets/google/types.ts';
import type { GoogleValidatedAccount } from './google-credentials.ts';
import { GOOGLE_WALLET_SCOPE, validateGoogleAccount } from './google-credentials.ts';
import { googleClassId, googleClassKeyDigest, googleObjectIds } from './google-ids.ts';
import { getGoogleAccessToken } from './google-oauth.ts';
import { createGoogleSaveOffer } from './google-offer.ts';
import {
  clearGoogleRestMemo,
  GOOGLE_RESOURCES,
  type GoogleWalletRestContext,
} from './google-rest.ts';
import {
  clearGoogleClassMemo,
  patchGoogleObjectBody,
  revokeGoogleObject,
  upsertGoogleClass,
  upsertGoogleObject,
} from './google-rest-typed.ts';
import { mockProviderInput } from './mock-endpoint.ts';

const env = {
  WALLET_MOCK_PROVIDERS_URL: 'http://localhost:5175',
  PUBLIC_BASE_URL: 'http://localhost:5173',
};
const secret = new Uint8Array(32).fill(7);
const ISSUER = '3388000000022334455';
const scope = {
  tenantId: 'tenant',
  releaseId: 'release',
  passId: 'pass',
  mode: 'test' as const,
  credentialGeneration: 1,
  channelEpoch: 1,
};
const text = (value: string) => ({ defaultValue: { language: 'en', value } });
const logo = {
  sourceUri: { uri: 'https://example.test/w/i/logo.png' },
  contentDescription: text('Logo'),
};
const barcode = { type: 'QR_CODE', renderEncoding: 'UTF_8', value: 'PSAMPLE' } as const;
const common = { multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES' } as const;
const typed = { ...common, issuerName: 'Club', reviewStatus: 'UNDER_REVIEW' } as const;

/** A class and an object body per type, shaped as the compilers make them. */
const BODIES: Record<GoogleType, { classBody: object; objectBody: object }> = {
  generic: {
    classBody: common,
    objectBody: {
      genericType: 'GENERIC_OTHER',
      state: 'ACTIVE',
      cardTitle: text('Club'),
      header: text('Member'),
      barcode,
    },
  },
  event: {
    classBody: { ...typed, eventName: text('Gala') },
    objectBody: { state: 'ACTIVE', ticketNumber: 'T1', barcode },
  },
  loyalty: {
    classBody: { ...typed, programName: 'Club', programLogo: logo },
    objectBody: { state: 'ACTIVE', accountId: 'M1', barcode },
  },
  gift: {
    classBody: { ...typed, merchantName: 'Club', programLogo: logo },
    objectBody: { state: 'ACTIVE', cardNumber: '123', barcode },
  },
  offer: {
    classBody: { ...typed, provider: 'Club', title: 'Deal', redemptionChannel: 'INSTORE' },
    objectBody: { state: 'ACTIVE', barcode },
  },
};
const TYPES = Object.keys(BODIES) as GoogleType[];

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
    issuerId: ISSUER,
    serviceAccountEmail: 'svc@example.iam.gserviceaccount.com',
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`,
    scopes: [GOOGLE_WALLET_SCOPE],
  });
});

beforeEach(() => {
  mock = createMockWallets();
  clearGoogleRestMemo();
  clearGoogleClassMemo();
});

const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const { redirect: _redirect, ...rest } = init ?? {};
  return mock.handle(new Request(mockProviderInput(env, input), rest));
}) as typeof fetch;

async function rest(f: typeof fetch = fetcher): Promise<GoogleWalletRestContext> {
  const token = await getGoogleAccessToken(account, { issuedAt: 1_700_000_000, fetcher: f });
  return { account, objectIdHmacKey: secret, accessToken: token.accessToken, fetcher: f };
}

describe('class ids', () => {
  it('keeps the Generic derivation and separates type and class key', async () => {
    const base = { tenantId: 't', releaseId: 'r' };
    const original = await googleClassId(ISSUER, secret, base);
    expect(await googleClassId(ISSUER, secret, { ...base, type: 'generic' })).toBe(original);
    const loyalty = await googleClassId(ISSUER, secret, { ...base, type: 'loyalty' });
    const gift = await googleClassId(ISSUER, secret, { ...base, type: 'gift' });
    const gala = await googleClassId(ISSUER, secret, {
      ...base,
      type: 'event',
      classKey: await googleClassKeyDigest('gala'),
    });
    const ball = await googleClassId(ISSUER, secret, {
      ...base,
      type: 'event',
      classKey: await googleClassKeyDigest('ball'),
    });
    expect(new Set([original, loyalty, gift, gala, ball]).size).toBe(5);
    // `default` is the absence of a key, never a second class.
    expect(await googleClassId(ISSUER, secret, { ...base, type: 'loyalty' })).toBe(loyalty);
  });

  it('keeps the class id fixed-length for any key length, unique per full key', async () => {
    const base = { tenantId: 't', releaseId: 'r', type: 'event' as GoogleType };
    const idOf = async (key: string) =>
      googleClassId(ISSUER, secret, { ...base, classKey: await googleClassKeyDigest(key) });
    const long = 'e'.repeat(355);
    const id = await idOf(long);
    expect(id.length).toBeLessThanOrEqual(200);
    expect(await idOf(long)).toBe(id);
    expect(await idOf(`${long.slice(0, -1)}f`)).not.toBe(id);
    expect((await idOf('gala')).length).toBe(id.length);
    expect(await googleClassKeyDigest('gala')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a class key that is not a digest', async () => {
    await expect(
      googleClassId(ISSUER, secret, {
        tenantId: 't',
        releaseId: 'r',
        type: 'event',
        classKey: 'gala',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('per-type class and object upsert', () => {
  it.each(TYPES)(
    "creates the %s class, then its object, under that type's collection",
    async (type) => {
      const ctx = await rest();
      const { classBody, objectBody } = BODIES[type];
      const classScope = { tenantId: scope.tenantId, releaseId: scope.releaseId };
      expect((await upsertGoogleClass(ctx, type, classScope, classBody as never)).result).toBe(
        'created',
      );
      const objectScope = { ...scope, type };
      expect(await upsertGoogleObject(ctx, type, objectScope, objectBody as never)).toBe('created');
      const { classId, objectId } = await googleObjectIds(ISSUER, secret, objectScope);
      const resources = GOOGLE_RESOURCES[type];
      expect(mock.google[resources.class].get(classId)).toMatchObject({ id: classId });
      expect(mock.google[resources.object].get(objectId)).toMatchObject({ id: objectId, classId });
      // Nothing leaked into another type's collections.
      for (const other of TYPES.filter((t) => t !== type))
        expect(mock.google[GOOGLE_RESOURCES[other].object].size).toBe(0);
      const offer = await createGoogleSaveOffer(account, secret, objectScope, {
        origins: ['http://localhost:5173'],
        issuedAt: 1_700_000_000,
        type,
      });
      expect((await fetcher(offer.url)).status).toBe(200);
      expect(mock.saves[0]?.objectIds).toEqual([objectId]);
    },
  );

  it('partitions event classes by class key: two events, two classes, one object each', async () => {
    const ctx = await rest();
    const body = BODIES.event;
    const keys = [await googleClassKeyDigest('gala'), await googleClassKeyDigest('ball')];
    for (const classKey of keys) {
      await upsertGoogleClass(
        ctx,
        'event',
        { tenantId: 't', releaseId: 'r', classKey },
        body.classBody as never,
      );
    }
    expect(mock.google.eventTicketClass.size).toBe(2);
  });

  it('does not send an unchanged class again, and ignores review state', async () => {
    const ctx = await rest();
    const { classBody } = BODIES.loyalty;
    const classScope = { tenantId: 't', releaseId: 'r' };
    expect((await upsertGoogleClass(ctx, 'loyalty', classScope, classBody as never)).result).toBe(
      'created',
    );
    const sent = () => mock.requests.filter((r) => r.path.includes('loyaltyClass')).length;
    expect((await upsertGoogleClass(ctx, 'loyalty', classScope, classBody as never)).result).toBe(
      'unchanged',
    );
    expect(sent()).toBe(1);
    // A fresh isolate: GET finds the class, Google has since approved it, and nothing is patched.
    clearGoogleClassMemo();
    for (const doc of mock.google.loyaltyClass.values()) doc.reviewStatus = 'APPROVED';
    expect((await upsertGoogleClass(ctx, 'loyalty', classScope, classBody as never)).result).toBe(
      'unchanged',
    );
    expect(mock.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
    // A changed body is drift: the class is kept as it is, never patched, so a second pass of the key
    // cannot rewrite it (or send it back through review).
    const changed = { ...classBody, programName: 'Club 2' };
    expect((await upsertGoogleClass(ctx, 'loyalty', classScope, changed as never)).result).toBe(
      'drift',
    );
    expect((await upsertGoogleClass(ctx, 'loyalty', classScope, changed as never)).result).toBe(
      'drift',
    );
    expect([...mock.google.loyaltyClass.values()][0]).toMatchObject({ programName: 'Club' });
    expect(mock.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
  });

  it('retries idempotently: a repeated object upsert patches the same object', async () => {
    const ctx = await rest();
    const { classBody, objectBody } = BODIES.gift;
    const objectScope = { ...scope, type: 'gift' as const };
    await upsertGoogleClass(
      ctx,
      'gift',
      { tenantId: 'tenant', releaseId: 'release' },
      classBody as never,
    );
    expect(await upsertGoogleObject(ctx, 'gift', objectScope, objectBody as never)).toBe('created');
    clearGoogleRestMemo();
    expect(await upsertGoogleObject(ctx, 'gift', objectScope, objectBody as never)).toBe('updated');
    expect(mock.google.giftCardObject.size).toBe(1);
  });

  it('refuses an object that already exists under another class', async () => {
    const ctx = await rest();
    const { classBody, objectBody } = BODIES.loyalty;
    await upsertGoogleClass(
      ctx,
      'loyalty',
      { tenantId: 'tenant', releaseId: 'release' },
      classBody as never,
    );
    await upsertGoogleObject(ctx, 'loyalty', { ...scope, type: 'loyalty' }, objectBody as never);
    const other = {
      ...scope,
      type: 'loyalty' as const,
      classKey: await googleClassKeyDigest('other'),
    };
    await upsertGoogleClass(
      ctx,
      'loyalty',
      { tenantId: 'tenant', releaseId: 'release', classKey: other.classKey },
      classBody as never,
    );
    // A fresh isolate has no memo of the object, so it reads it and finds the other class.
    clearGoogleRestMemo();
    await expect(
      upsertGoogleObject(ctx, 'loyalty', other, objectBody as never),
    ).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('PATCHes an object through the one body path (change messages build on it)', async () => {
    const ctx = await rest();
    const { classBody, objectBody } = BODIES.event;
    const objectScope = { ...scope, type: 'event' as const };
    await upsertGoogleClass(
      ctx,
      'event',
      { tenantId: 'tenant', releaseId: 'release' },
      classBody as never,
    );
    await upsertGoogleObject(ctx, 'event', objectScope, objectBody as never);
    // A notifying message never rides in a PATCH body (google-messages.md decision 2): only addMessage notifies.
    await expect(
      patchGoogleObjectBody(ctx, 'event', objectScope, {
        messages: [{ id: 'm1', header: 'Hi', body: 'Doors at 7', messageType: 'TEXT_AND_NOTIFY' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await patchGoogleObjectBody(ctx, 'event', objectScope, {
      messages: [{ id: 'm1', header: 'Hi', body: 'Doors at 7', messageType: 'TEXT' }],
    });
    const { objectId } = await googleObjectIds(ISSUER, secret, objectScope);
    expect(mock.google.eventTicketObject.get(objectId)).toMatchObject({
      ticketNumber: 'T1',
      messages: [{ id: 'm1' }],
    });
  });
});

describe('revoke: PUT inactive, then GET to confirm', () => {
  async function issued(type: GoogleType) {
    const ctx = await rest();
    const { classBody, objectBody } = BODIES[type];
    const objectScope = { ...scope, type };
    await upsertGoogleClass(
      ctx,
      type,
      { tenantId: 'tenant', releaseId: 'release' },
      classBody as never,
    );
    await upsertGoogleObject(ctx, type, objectScope, objectBody as never);
    const mark = mock.requests.length;
    const { objectId } = await googleObjectIds(ISSUER, secret, objectScope);
    return { ctx, objectScope, objectId, mark, resource: GOOGLE_RESOURCES[type].object };
  }
  const message = { id: 'op-1', header: 'Pass status', body: 'This pass is no longer valid.' };

  it.each(TYPES)(
    '%s: the object ends inactive, without its barcode, with one message',
    async (type) => {
      const { ctx, objectScope, objectId, mark, resource } = await issued(type);
      await revokeGoogleObject(ctx, type, objectScope, message);
      const stored = mock.google[resource].get(objectId);
      expect(stored).toMatchObject({
        id: objectId,
        state: 'INACTIVE',
        messages: [{ id: 'op-1', body: 'This pass is no longer valid.' }],
      });
      expect(stored).not.toHaveProperty('barcode');
      // It keeps the rest of what Google held: a PUT replaces, so nothing may be dropped by accident.
      expect(stored?.classId).toMatch(new RegExp(`^${ISSUER}\\.c_`));
      expect(mock.requests.slice(mark).map((r) => r.method)).toEqual(['GET', 'PUT', 'GET']);
    },
  );

  it('retries idempotently: a second revoke leaves one message and the same state', async () => {
    const { ctx, objectScope, objectId, resource } = await issued('loyalty');
    await revokeGoogleObject(ctx, 'loyalty', objectScope, message);
    await revokeGoogleObject(ctx, 'loyalty', objectScope, message);
    expect(mock.google[resource].get(objectId)).toMatchObject({
      state: 'INACTIVE',
      messages: [{ id: 'op-1' }],
    });
  });

  it('retries rather than settles when Google gives the object back still active', async () => {
    const { objectScope, resource } = await issued('offer');
    // Google acknowledges the PUT but serves the old object on the read back.
    let held: unknown;
    const stale = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      if (method === 'GET' && url.includes(resource) && held === undefined) {
        const response = await fetcher(input, init);
        held = await response.clone().json();
        return response;
      }
      if (method === 'PUT') {
        await fetcher(input, init);
        return Response.json(held);
      }
      if (method === 'GET' && url.includes(resource)) return Response.json(held);
      return fetcher(input, init);
    }) as typeof fetch;
    const ctx = await rest(stale);
    // A distinct code, which the operation classes as a retry (the PUT is a full replace).
    await expect(revokeGoogleObject(ctx, 'offer', objectScope, message)).rejects.toMatchObject({
      code: 'invalid_response',
      operation: expect.stringContaining('confirm'),
    });
    // The retry reads a good copy and settles.
    const again = await rest();
    expect(await revokeGoogleObject(again, 'offer', objectScope, message)).toBe('inactive');
  });

  it('accepts the state in any case, and does not send the tap value or output-only fields', async () => {
    const { ctx, objectScope, objectId, resource } = await issued('loyalty');
    Object.assign(mock.google[resource].get(objectId) ?? {}, {
      smartTapRedemptionValue: 'tap',
      hasUsers: true,
      version: '3',
      kind: 'walletobjects#loyaltyObject',
    });
    const lower = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetcher(input, init);
      if ((init?.method ?? 'GET') !== 'GET' || !String(input).includes(resource)) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...body, state: String(body.state).toLowerCase() });
    }) as typeof fetch;
    expect(
      await revokeGoogleObject({ ...ctx, fetcher: lower }, 'loyalty', objectScope, message),
    ).toBe('inactive');
    const put = mock.requests.find((r) => r.method === 'PUT')?.body as Record<string, unknown>;
    for (const key of ['smartTapRedemptionValue', 'hasUsers', 'version', 'kind', 'barcode'])
      expect(put).not.toHaveProperty(key);
  });

  it('refuses an object that sits under another class of the issuer', async () => {
    const { ctx, objectScope, objectId, resource } = await issued('loyalty');
    const other = await googleClassId(ISSUER, secret, {
      tenantId: 'other-org',
      releaseId: 'r',
      type: 'loyalty',
    });
    mock.google.loyaltyClass.set(other, { id: other });
    Object.assign(mock.google[resource].get(objectId) ?? {}, { classId: other });
    await expect(revokeGoogleObject(ctx, 'loyalty', objectScope, message)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(mock.requests.filter((r) => r.method === 'PUT')).toEqual([]);
    // The class the instance was issued under (its binding's hash) is what the revoke keeps to.
    const { sha256Hex } = await import('../../platform/ids.ts');
    expect(
      await revokeGoogleObject(ctx, 'loyalty', objectScope, message, await sha256Hex(other)),
    ).toBe('inactive');
  });

  it('treats an object Google does not have as absent, and sends nothing', async () => {
    const ctx = await rest();
    expect(await revokeGoogleObject(ctx, 'event', { ...scope, type: 'event' }, message)).toBe(
      'absent',
    );
    expect(mock.requests.filter((r) => r.method === 'PUT')).toEqual([]);
  });
});
