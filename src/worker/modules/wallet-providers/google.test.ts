import { beforeAll, describe, expect, it } from 'vitest';
import {
  GOOGLE_WALLET_SCOPE,
  type GoogleAccountCredentials,
  type GoogleValidatedAccount,
  validateGoogleAccount,
} from './google-credentials.ts';
import { googleClassId, googleObjectIds } from './google-ids.ts';
import { getGoogleAccessToken } from './google-oauth.ts';
import { createGoogleSaveOffer } from './google-offer.ts';

const now = 1_700_000_000;
const idSecret = new Uint8Array(32).fill(42);
const scope = {
  tenantId: 'tenant-private',
  releaseId: 'release-private',
  passId: 'pass-private',
  mode: 'live' as const,
  credentialGeneration: 1,
};
let credentials: GoogleAccountCredentials;
let account: GoogleValidatedAccount;
let publicKey: CryptoKey;

function decode64(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

async function inspectJwt(jwt: string) {
  const [header, payload, signature] = jwt.split('.');
  if (!header || !payload || !signature) throw new Error('Invalid test JWT');
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    decode64(signature) as BufferSource,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return {
    verified,
    header: JSON.parse(new TextDecoder().decode(decode64(header))) as Record<string, unknown>,
    payload: JSON.parse(new TextDecoder().decode(decode64(payload))) as Record<string, unknown>,
  };
}

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
  publicKey = pair.publicKey;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  const base64 = btoa(Array.from(der, (byte) => String.fromCharCode(byte)).join(''));
  credentials = {
    issuerId: '33880000000223344',
    serviceAccountEmail: 'wallet-service@example-project.iam.gserviceaccount.com',
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`,
    scopes: [GOOGLE_WALLET_SCOPE],
  };
  account = await validateGoogleAccount(credentials);
});

describe('Google account credentials and scoped IDs', () => {
  it('imports a nonextractable RSA SHA-256 signing key and rejects invalid configuration', async () => {
    expect(account.signingKey.extractable).toBe(false);
    expect(account.signingKey.algorithm).toMatchObject({
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
    });
    const invalid = [
      { issuerId: '' },
      { issuerId: '123.example' },
      { serviceAccountEmail: 'holder@example.com' },
      { serviceAccountEmail: 'bad\n@developer.gserviceaccount.com' },
      { scopes: [] },
      { scopes: [GOOGLE_WALLET_SCOPE, 'https://www.googleapis.com/auth/cloud-platform'] },
      { privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' },
      { privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' },
    ];
    for (const changes of invalid) {
      await expect(validateGoogleAccount({ ...credentials, ...changes })).rejects.toMatchObject({
        code: 'invalid_credentials',
      });
    }
    const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const ecDer = new Uint8Array(
      (await crypto.subtle.exportKey('pkcs8', ec.privateKey)) as ArrayBuffer,
    );
    const ecPem = btoa(Array.from(ecDer, (byte) => String.fromCharCode(byte)).join(''));
    await expect(
      validateGoogleAccount({
        ...credentials,
        privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${ecPem}\n-----END PRIVATE KEY-----`,
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('derives stable, opaque, collision-separated issuer/tenant/release/pass IDs', async () => {
    const ids = await googleObjectIds(account.issuerId, idSecret, scope);
    expect(ids).toEqual(await googleObjectIds(account.issuerId, idSecret, { ...scope }));
    expect(ids.classId).toBe(await googleClassId(account.issuerId, idSecret, scope));
    expect(ids.classId).toMatch(/^33880000000223344\.c_[A-Za-z0-9_-]{43}$/);
    expect(ids.objectId).toMatch(/^33880000000223344\.o_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(ids)).not.toContain('private');
    const otherPass = await googleObjectIds(account.issuerId, idSecret, {
      ...scope,
      passId: 'other',
    });
    expect(otherPass.classId).toBe(ids.classId);
    expect(otherPass.objectId).not.toBe(ids.objectId);
    const otherTenant = await googleObjectIds(account.issuerId, idSecret, {
      ...scope,
      tenantId: 'other',
    });
    expect(otherTenant.classId).not.toBe(ids.classId);
    expect(otherTenant.objectId).not.toBe(ids.objectId);
    const newerRelease = await googleObjectIds(account.issuerId, idSecret, {
      ...scope,
      releaseId: 'newer',
    });
    expect(newerRelease.classId).not.toBe(ids.classId);
    expect(newerRelease.objectId).toBe(ids.objectId);
    const newHolder = await googleObjectIds(account.issuerId, idSecret, {
      ...scope,
      credentialGeneration: 2,
    });
    expect(newHolder.classId).toBe(ids.classId);
    expect(newHolder.objectId).not.toBe(ids.objectId);
    const testMode = await googleObjectIds(account.issuerId, idSecret, {
      ...scope,
      mode: 'test',
    });
    expect(testMode.objectId).not.toBe(ids.objectId);
    expect((await googleObjectIds('123', idSecret, scope)).objectId).not.toBe(ids.objectId);
    expect(
      (await googleObjectIds(account.issuerId, new Uint8Array(32).fill(43), scope)).objectId,
    ).not.toBe(ids.objectId);
    await expect(
      googleObjectIds(account.issuerId, new Uint8Array(31), scope),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      googleObjectIds(account.issuerId, idSecret, { ...scope, passId: '' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      googleObjectIds(account.issuerId, idSecret, {
        ...scope,
        credentialGeneration: -1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      googleObjectIds(account.issuerId, idSecret, {
        ...scope,
        credentialGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      googleObjectIds(account.issuerId, idSecret, {
        ...scope,
        credentialGeneration: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('Save to Google Wallet JWT', () => {
  it('signs an ID-only existing-object reference with a 15-minute expiry', async () => {
    const result = await createGoogleSaveOffer(account, idSecret, scope, {
      origins: ['https://passbook.mobile'],
      issuedAt: now,
    });
    expect(result.url).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect(result.expiresAt).toBe(now + 900);
    const jwt = result.url.slice('https://pay.google.com/gp/v/save/'.length);
    const decoded = await inspectJwt(jwt);
    expect(decoded.verified).toBe(true);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    const ids = await googleObjectIds(account.issuerId, idSecret, scope);
    expect(decoded.payload).toEqual({
      iss: credentials.serviceAccountEmail,
      aud: 'google',
      typ: 'savetowallet',
      iat: now,
      exp: now + 900,
      origins: ['https://passbook.mobile'],
      payload: { genericObjects: [{ id: ids.objectId }] },
    });
    expect(result.url).not.toContain(credentials.privateKeyPem);
  });

  it('signs distinct object references for successive holder generations', async () => {
    const options = { origins: ['https://passbook.mobile'], issuedAt: now };
    const nextScope = { ...scope, credentialGeneration: scope.credentialGeneration + 1 };
    const [oldOffer, nextOffer, oldIds, nextIds] = await Promise.all([
      createGoogleSaveOffer(account, idSecret, scope, options),
      createGoogleSaveOffer(account, idSecret, nextScope, options),
      googleObjectIds(account.issuerId, idSecret, scope),
      googleObjectIds(account.issuerId, idSecret, nextScope),
    ]);
    const prefix = 'https://pay.google.com/gp/v/save/';
    const [oldJwt, nextJwt] = await Promise.all([
      inspectJwt(oldOffer.url.slice(prefix.length)),
      inspectJwt(nextOffer.url.slice(prefix.length)),
    ]);
    expect(oldJwt.verified).toBe(true);
    expect(nextJwt.verified).toBe(true);
    expect(oldIds.classId).toBe(nextIds.classId);
    expect(oldIds.objectId).not.toBe(nextIds.objectId);
    expect(oldJwt.payload.payload).toEqual({ genericObjects: [{ id: oldIds.objectId }] });
    expect(nextJwt.payload.payload).toEqual({ genericObjects: [{ id: nextIds.objectId }] });
  });

  it('supports a shorter offer and rejects long lifetimes and unsafe origins', async () => {
    const offer = await createGoogleSaveOffer(account, idSecret, scope, {
      origins: [],
      issuedAt: now,
      lifetimeSeconds: 60,
    });
    expect(offer.expiresAt).toBe(now + 60);
    for (const lifetimeSeconds of [0, -1, 901, 1.5]) {
      await expect(
        createGoogleSaveOffer(account, idSecret, scope, {
          origins: [],
          issuedAt: now,
          lifetimeSeconds,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(
      createGoogleSaveOffer(account, idSecret, scope, {
        origins: ['https://user:secret@example.com/path'],
        issuedAt: now,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('Google OAuth service-account exchange', () => {
  it('signs the documented scoped assertion and exchanges it for a bearer token', async () => {
    let requestBody = '';
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('content-type')).toBe(
        'application/x-www-form-urlencoded',
      );
      requestBody = String(init?.body);
      return Response.json({
        access_token: 'ya29.test-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }) as typeof fetch;
    const token = await getGoogleAccessToken(account, { issuedAt: now, fetcher });
    expect(token).toEqual({ accessToken: 'ya29.test-token', expiresAt: now + 3600 });
    const form = new URLSearchParams(requestBody);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const decoded = await inspectJwt(form.get('assertion') ?? '');
    expect(decoded.verified).toBe(true);
    expect(decoded.payload).toEqual({
      iss: credentials.serviceAccountEmail,
      scope: GOOGLE_WALLET_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 300,
    });
  });

  it('classifies OAuth failures without exposing provider bodies or request details', async () => {
    const secret = 'sensitive-access-token-and-body';
    const rejected = (async () => new Response(secret, { status: 403 })) as typeof fetch;
    try {
      await getGoogleAccessToken(account, { issuedAt: now, fetcher: rejected });
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'forbidden', status: 403 });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    const malformed = (async () =>
      Response.json({ access_token: secret, token_type: 'wrong', expires_in: 1 })) as typeof fetch;
    await expect(
      getGoogleAccessToken(account, { issuedAt: now, fetcher: malformed }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    const unavailable = (async () => {
      throw new Error(secret);
    }) as typeof fetch;
    await expect(
      getGoogleAccessToken(account, { issuedAt: now, fetcher: unavailable }),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
