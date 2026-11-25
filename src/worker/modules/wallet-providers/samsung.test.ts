import { constants, privateDecrypt } from 'node:crypto';
import * as asn1 from 'asn1js';
import { CompactSign, compactVerify, importX509 } from 'jose';
import * as pki from 'pkijs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectRejectsCode } from '../../../../test/helpers/denial.ts';
import { fromBase64Url } from '../../platform/ids.ts';
import {
  buildSamsungDataFetchLink,
  classifySamsungFailure,
  createSamsungCardDataToken,
  createSamsungRefId,
  type SamsungCardProjection,
  SamsungCredentialError,
  SamsungNotificationError,
  type SamsungPartnerCredentials,
  SamsungTokenError,
  samsungCardDataResponse,
  sendSamsungCancel,
  sendSamsungUpdate,
  type ValidatedSamsungCredentials,
  validateSamsungCallbackCredentials,
  validateSamsungCredentials,
  verifySamsungRequest,
  verifySamsungTombstoneRequest,
} from './samsung.ts';
import {
  SAMSUNG_CLOCK_SKEW_MS,
  SAMSUNG_REQUEST_TIMEOUT_MS,
  SAMSUNG_TOKEN_WINDOW_MS,
} from './samsung-limits.ts';

const NOW = Date.UTC(2026, 0, 1);
const utf8 = new TextEncoder();
const text = new TextDecoder();
const engine = new pki.CryptoEngine({
  name: 'WebCrypto',
  crypto,
  subtle: crypto.subtle,
}) as unknown as pki.ICryptoEngine;

function pem(label: string, der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `-----BEGIN ${label}-----\n${btoa(binary)
    .match(/.{1,64}/g)
    ?.join('\n')}\n-----END ${label}-----\n`;
}

async function makeIdentity(): Promise<{
  certificate: string;
  privateKey: string;
  key: CryptoKey;
}> {
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
  const cert = new pki.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1.Integer({ value: 1 });
  const name = new pki.RelativeDistinguishedNames({
    typesAndValues: [
      new pki.AttributeTypeAndValue({
        type: '2.5.4.3',
        value: new asn1.Utf8String({ value: 'Test onboarding certificate' }),
      }),
    ],
  });
  cert.issuer = name;
  cert.subject = name;
  cert.notBefore.value = new Date(NOW - 60_000);
  cert.notAfter.value = new Date(NOW + 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(pair.publicKey, engine);
  await cert.sign(pair.privateKey, 'SHA-256', engine);
  return {
    certificate: pem('CERTIFICATE', cert.toSchema(true).toBER(false)),
    privateKey: pem(
      'PRIVATE KEY',
      (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
    ),
    key: pair.privateKey,
  };
}

let credentials: SamsungPartnerCredentials;
let account: ValidatedSamsungCredentials;
let samsung: { certificate: string; privateKey: string; key: CryptoKey };
let partner: { certificate: string; privateKey: string; key: CryptoKey };
const refId = 'abcdefghijklmnopqrstuvwxABCDEFGH';
const projection: SamsungCardProjection = {
  card: {
    type: 'loyalty',
    subType: 'others',
    data: [
      {
        refId,
        createdAt: NOW - 500,
        updatedAt: NOW,
        state: 'ACTIVE',
        language: 'en',
        attributes: { title: 'Approved title', 'barcode.value': 'sensitive value' },
      },
    ],
  },
};

beforeAll(async () => {
  [partner, samsung] = await Promise.all([makeIdentity(), makeIdentity()]);
  credentials = {
    partnerId: '1234567890123456789',
    certificateId: 'YMtt',
    cardId: 'card123',
    partnerPrivateKeyPem: partner.privateKey,
    partnerCertificatePem: partner.certificate,
    samsungCertificatePem: samsung.certificate,
  };
  account = await validateSamsungCredentials(credentials, NOW);
}, 30_000);

async function signedAuth(
  input: {
    method?: string;
    path?: string;
    utc?: number;
    refId?: string;
    omitRefId?: boolean;
    key?: CryptoKey;
    partnerId?: string;
    certificateId?: string;
    cty?: string;
  } = {},
): Promise<string> {
  const path = input.path ?? `/cards/card123/${refId}`;
  return new CompactSign(
    utf8.encode(
      JSON.stringify({
        API: { method: input.method ?? 'GET', path },
        refId: input.omitRefId ? undefined : (input.refId ?? refId),
      }),
    ),
  )
    .setProtectedHeader({
      alg: 'RS256',
      cty: input.cty ?? 'AUTH',
      ver: '3',
      certificateId: input.certificateId ?? 'YMtt',
      partnerId: input.partnerId ?? credentials.partnerId,
      utc: input.utc ?? NOW,
    })
    .sign(input.key ?? samsung.key);
}

function inbound(
  token: string,
  options: { method?: string; suffix?: string; requestId?: string; prefix?: string } = {},
): Request {
  return new Request(
    `https://example.test${options.prefix ?? ''}/cards/card123/${refId}${options.suffix ?? ''}`,
    {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-request-id': options.requestId ?? 'request-1',
      },
    },
  );
}

function replayStore(): (key: string, expiresAt: number) => Promise<boolean> {
  const seen = new Set<string>();
  return async (key, expiresAt) => {
    if (expiresAt < NOW || seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

async function decryptedCard(token: string): Promise<unknown> {
  const publicKey = await importX509(partner.certificate, 'RS256');
  const outer = await compactVerify(token, publicKey, { algorithms: ['RS256'] });
  expect(outer.protectedHeader).toMatchObject({
    alg: 'RS256',
    cty: 'CARD',
    ver: '3',
    certificateId: 'YMtt',
    partnerId: credentials.partnerId,
    utc: NOW,
  });
  const parts = text.decode(outer.payload).split('.');
  expect(parts).toHaveLength(5);
  const [protectedHeader = '', encryptedKey = '', iv = '', ciphertext = '', tag = ''] = parts;
  expect(JSON.parse(text.decode(fromBase64Url(protectedHeader)))).toEqual({
    alg: 'RSA1_5',
    enc: 'A128GCM',
  });
  // Test-only raw RSA recovery checks the provider's v1.5 envelope independently of the writer.
  const encoded = privateDecrypt(
    { key: samsung.privateKey, padding: constants.RSA_NO_PADDING },
    fromBase64Url(encryptedKey),
  );
  expect(encoded[0]).toBe(0);
  expect(encoded[1]).toBe(2);
  const separator = encoded.indexOf(0, 2);
  expect(separator).toBeGreaterThanOrEqual(10);
  const cek = encoded.subarray(separator + 1);
  expect(cek.byteLength).toBe(16);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const encrypted = new Uint8Array([...fromBase64Url(ciphertext), ...fromBase64Url(tag)]);
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64Url(iv),
      additionalData: utf8.encode(protectedHeader),
      tagLength: 128,
    },
    key,
    encrypted,
  );
  encrypted[0] = (encrypted[0] ?? 0) ^ 1;
  await expect(
    crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(iv),
        additionalData: utf8.encode(protectedHeader),
        tagLength: 128,
      },
      key,
      encrypted,
    ),
  ).rejects.toThrow(/Decryption failed/);
  return JSON.parse(text.decode(plain));
}

describe('Samsung credentials and Data Fetch', () => {
  it('validates certificates, RSA key matching, identifiers, and validity dates', async () => {
    await expect(
      validateSamsungCredentials({ ...credentials, partnerPrivateKeyPem: 'invalid secret' }, NOW),
    ).rejects.toBeInstanceOf(SamsungCredentialError);
    await expect(
      validateSamsungCredentials({ ...credentials, partnerPrivateKeyPem: samsung.privateKey }, NOW),
    ).rejects.toBeInstanceOf(SamsungCredentialError);
    await expect(
      validateSamsungCredentials(
        { ...credentials, samsungCertificatePem: 'not a certificate' },
        NOW,
      ),
    ).rejects.toBeInstanceOf(SamsungCredentialError);
    await expect(
      validateSamsungCredentials({ ...credentials, certificateId: 'bad/id' }, NOW),
    ).rejects.toBeInstanceOf(SamsungCredentialError);
    await expect(
      validateSamsungCredentials(
        {
          ...credentials,
          partnerId: undefined as unknown as string,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(SamsungCredentialError);
    await expect(validateSamsungCredentials(credentials, NOW + 86_400_001)).rejects.toBeInstanceOf(
      SamsungCredentialError,
    );
  });

  it('creates unpredictable references within the documented 32-character limit', () => {
    const refs = Array.from({ length: 256 }, () => createSamsungRefId());
    expect(new Set(refs).size).toBe(refs.length);
    for (const ref of refs) expect(ref).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(buildSamsungDataFetchLink(account, refs[0] ?? '', NOW)).toBe(
      `https://a.swallet.link/atw/v3/YMtt/card123#Clip?pdata=${refs[0]}`,
    );
    expect(() => buildSamsungDataFetchLink(account, 'guessable', NOW)).toThrow();
    expect(() => buildSamsungDataFetchLink({ ...account }, refId, NOW)).toThrow(
      SamsungCredentialError,
    );
  });

  it('signs the documented JWS-wrapped JWE and decrypts the original approved projection', async () => {
    const token = await createSamsungCardDataToken(account, projection, NOW);
    expect(token).not.toContain('sensitive value');
    expect(await decryptedCard(token)).toEqual(projection);
    const segments = token.split('.');
    const signature = segments[2] ?? '';
    segments[2] = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    const key = await importX509(partner.certificate, 'RS256');
    await expectRejectsCode(
      compactVerify(segments.join('.'), key),
      'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    );
  });
});

describe('Samsung authenticated requests', () => {
  it('authenticates tombstones with historical public material and never grants card rendering', async () => {
    const publicInput = {
      partnerId: credentials.partnerId,
      certificateId: credentials.certificateId,
      cardId: credentials.cardId,
      samsungCertificatePem: credentials.samsungCertificatePem,
    };
    const publicAccount = await validateSamsungCallbackCredentials(publicInput, NOW);
    expect(publicAccount).not.toHaveProperty('partnerSigningKey');
    expect(publicAccount).not.toHaveProperty('partnerPrivateKeyPem');
    const token = await signedAuth();
    const claimReplay = replayStore();
    const proof = await verifySamsungTombstoneRequest(publicAccount, {
      request: inbound(token, { suffix: '?fields=title' }),
      method: 'GET',
      refId,
      claimReplay,
      now: NOW,
    });
    expect(proof).toMatchObject({ refId, signedAt: NOW, queryBound: false });
    await expect(
      verifySamsungTombstoneRequest(publicAccount, {
        request: inbound(token),
        method: 'GET',
        refId,
        claimReplay,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(SamsungTokenError);
    const wrongCertificate = await validateSamsungCallbackCredentials(
      {
        ...publicInput,
        samsungCertificatePem: partner.certificate,
      },
      NOW,
    );
    await expect(
      verifySamsungTombstoneRequest(wrongCertificate, {
        request: inbound(token),
        method: 'GET',
        refId,
        claimReplay: replayStore(),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(SamsungTokenError);
    await expect(
      validateSamsungCallbackCredentials(publicInput, NOW + 86_400_001),
    ).rejects.toBeInstanceOf(SamsungCredentialError);
    const fullAccountTombstone = await verifySamsungTombstoneRequest(account, {
      request: inbound(token),
      method: 'GET',
      refId,
      claimReplay: replayStore(),
      now: NOW,
    });
    await expect(
      samsungCardDataResponse(account, fullAccountTombstone, projection, NOW),
    ).rejects.toBeInstanceOf(SamsungTokenError);
  });

  it('binds account, method, path and ref; marks path-only queries as untrusted', async () => {
    const token = await signedAuth();
    const verified = await verifySamsungRequest(account, {
      request: inbound(token, { suffix: '?fields=title' }),
      method: 'GET',
      refId,
      claimReplay: replayStore(),
      now: NOW,
    });
    expect(verified).toMatchObject({ method: 'GET', refId, queryBound: false, signedAt: NOW });
    const response = await samsungCardDataResponse(account, verified, projection, NOW);
    expect(await decryptedCard(response.cdata)).toEqual(projection);
    await expect(
      samsungCardDataResponse(account, { ...verified }, projection, NOW),
    ).rejects.toBeInstanceOf(SamsungTokenError);
    const revalidated = await validateSamsungCredentials(credentials, NOW);
    await expect(
      samsungCardDataResponse(revalidated, verified, projection, NOW),
    ).rejects.toBeInstanceOf(SamsungTokenError);
    await expect(
      samsungCardDataResponse(
        account,
        verified,
        {
          card: { ...projection.card, data: [{ ...projection.card.data[0]!, refId: 'other' }] },
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(SamsungTokenError);
  });

  it('recognizes an exactly signed query but rejects query tampering in that form', async () => {
    const path = `/cards/card123/${refId}?cc2=US&event=ADDED`;
    const token = await signedAuth({ method: 'POST', path });
    const verified = await verifySamsungRequest(account, {
      request: inbound(token, { method: 'POST', suffix: '?cc2=US&event=ADDED' }),
      method: 'POST',
      refId,
      now: NOW,
      claimReplay: async (_key, expiresAt, signedAt, queryBound) => {
        expect(expiresAt).toBe(NOW + SAMSUNG_TOKEN_WINDOW_MS + SAMSUNG_CLOCK_SKEW_MS);
        expect(signedAt).toBe(NOW);
        expect(queryBound).toBe(true);
        return true;
      },
    });
    expect(verified.queryBound).toBe(true);
    await expect(
      verifySamsungRequest(account, {
        request: inbound(token, { method: 'POST', suffix: '?cc2=US&event=DELETED' }),
        method: 'POST',
        refId,
        claimReplay: replayStore(),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(SamsungTokenError);
  });

  it('accepts the full signed pathname or the /cards suffix, never another path', async () => {
    const prefix = '/wallet/v1/samsung';
    const suffix = `/cards/card123/${refId}`;
    for (const path of [`${prefix}${suffix}`, suffix])
      await expect(
        verifySamsungRequest(account, {
          request: inbound(await signedAuth({ path }), { prefix }),
          method: 'GET',
          refId,
          claimReplay: replayStore(),
          now: NOW,
        }),
      ).resolves.toMatchObject({ refId, queryBound: false });
    for (const path of [
      `/other${suffix}`,
      `${prefix}/cards/other123/${refId}`,
      `${suffix}/`,
      `${prefix}${suffix}x`,
      '/',
    ])
      await expect(
        verifySamsungRequest(account, {
          request: inbound(await signedAuth({ path }), { prefix }),
          method: 'GET',
          refId,
          claimReplay: replayStore(),
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(SamsungTokenError);
    // A path naming another ref is refused even when the payload carries no refId to contradict it.
    for (const path of [
      `/cards/card123/${'Z'.repeat(32)}`,
      `${prefix}/cards/card123/${'Z'.repeat(32)}`,
    ])
      await expect(
        verifySamsungRequest(account, {
          request: inbound(await signedAuth({ path, omitRefId: true }), { prefix }),
          method: 'GET',
          refId,
          claimReplay: replayStore(),
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(SamsungTokenError);
    // Method, card id and ref id stay bound whichever form is signed.
    for (const signed of [
      { path: suffix, method: 'POST' },
      { path: suffix, refId: 'another' },
    ])
      await expect(
        verifySamsungRequest(account, {
          request: inbound(await signedAuth(signed), { prefix }),
          method: 'GET',
          refId,
          claimReplay: replayStore(),
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(SamsungTokenError);
    const query = '?cc2=US&event=ADDED';
    const bound = await verifySamsungRequest(account, {
      request: inbound(await signedAuth({ method: 'POST', path: `${suffix}${query}` }), {
        method: 'POST',
        prefix,
        suffix: query,
      }),
      method: 'POST',
      refId,
      claimReplay: replayStore(),
      now: NOW,
    });
    expect(bound.queryBound).toBe(true);
  });

  it('accepts a token up to the five-minute window and keeps its replay key for the window', async () => {
    const seen: number[] = [];
    const claimReplay = async (_key: string, expiresAt: number) => {
      seen.push(expiresAt);
      return true;
    };
    // The certificate is valid from NOW, so the token is signed at NOW and checked late.
    const late = NOW + SAMSUNG_TOKEN_WINDOW_MS;
    await verifySamsungRequest(account, {
      request: inbound(await signedAuth({ utc: NOW })),
      method: 'GET',
      refId,
      claimReplay,
      now: late,
    });
    // The key outlives the last instant the token itself is accepted.
    expect(seen).toEqual([NOW + SAMSUNG_TOKEN_WINDOW_MS + SAMSUNG_CLOCK_SKEW_MS]);
    expect(seen[0]).toBeGreaterThan(late);
    await expect(
      verifySamsungRequest(account, {
        request: inbound(await signedAuth({ utc: NOW })),
        method: 'GET',
        refId,
        claimReplay,
        now: late + 1,
      }),
    ).rejects.toBeInstanceOf(SamsungTokenError);
    await expect(
      verifySamsungRequest(account, {
        request: inbound(await signedAuth({ utc: late + SAMSUNG_CLOCK_SKEW_MS })),
        method: 'GET',
        refId,
        claimReplay,
        now: late,
      }),
    ).resolves.toMatchObject({ refId });
  });

  it('rejects replay even when unsigned request-id changes', async () => {
    const claimReplay = replayStore();
    const token = await signedAuth();
    await verifySamsungRequest(account, {
      request: inbound(token),
      method: 'GET',
      refId,
      claimReplay,
      now: NOW,
    });
    await expect(
      verifySamsungRequest(account, {
        request: inbound(token, { requestId: 'request-2' }),
        method: 'GET',
        refId,
        claimReplay,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(SamsungTokenError);
  });

  it('fails closed without leaking replay store errors', async () => {
    const token = await signedAuth();
    await expect(
      verifySamsungRequest(account, {
        request: inbound(token),
        method: 'GET',
        refId,
        now: NOW,
        claimReplay: async () => {
          throw new Error('private storage details');
        },
      }),
    ).rejects.toMatchObject({
      name: 'SamsungReplayStoreError',
      message: 'Samsung Wallet replay protection is unavailable.',
    });
  });

  it('rejects forged, stale, future, misbound or wrong-account credentials', async () => {
    const tokens = await Promise.all([
      signedAuth({ key: partner.key }),
      signedAuth({ utc: NOW - SAMSUNG_TOKEN_WINDOW_MS - 1 }),
      signedAuth({ utc: NOW + SAMSUNG_CLOCK_SKEW_MS + 1 }),
      signedAuth({ partnerId: 'wrong' }),
      signedAuth({ certificateId: 'ABCD' }),
      signedAuth({ method: 'POST' }),
      signedAuth({ path: `/cards/card123/another` }),
      signedAuth({ refId: 'another' }),
      signedAuth({ cty: 'CARD' }),
    ]);
    for (const token of tokens)
      await expect(
        verifySamsungRequest(account, {
          request: inbound(token),
          method: 'GET',
          refId,
          claimReplay: replayStore(),
          now: NOW,
        }),
      ).rejects.toBeInstanceOf(SamsungTokenError);
  });
});

describe('Samsung notifications', () => {
  it('bounds every request by the shared timeout and reports a timeout as an ambiguous network failure', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      let signal: AbortSignal | null | undefined;
      const fetcher = (async (_url: unknown, init?: RequestInit) => {
        signal = init?.signal;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }) as typeof fetch;
      await expect(
        sendSamsungUpdate(
          account,
          {
            cc2: 'US',
            requestId: 'req-1',
            type: 'loyalty',
            refId,
            state: 'UPDATED',
            attempt: 1,
            now: NOW,
          },
          fetcher,
        ),
      ).rejects.toMatchObject({ kind: 'network', retryable: true, ambiguous: true });
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(timeout).toHaveBeenCalledWith(SAMSUNG_REQUEST_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });

  it('never sends MIGRATED and validates the trace id', async () => {
    const calls: { init: RequestInit }[] = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ init: init as RequestInit });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const base = { cc2: 'US', requestId: 'req-1', type: 'loyalty', refId, attempt: 1, now: NOW };
    for (const input of [
      { ...base, state: 'MIGRATED' as never },
      { ...base, state: 'UPDATED' as const, requestId: '' },
      { ...base, state: 'UPDATED' as const, requestId: 'x'.repeat(33) },
    ])
      await expect(sendSamsungUpdate(account, input, fetcher)).rejects.toMatchObject({
        kind: 'invalid_request',
      });
    expect(calls).toHaveLength(0);
  });

  it('sends signed per-ref updates and event-wide cancels to the fixed public origin', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url !== 'string' || !init) throw new Error('invalid test call');
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await sendSamsungUpdate(
      account,
      {
        cc2: 'US',
        requestId: 'req-1',
        type: 'loyalty',
        refId,
        state: 'UPDATED',
        attempt: 1,
        now: NOW,
      },
      fetcher,
    );
    await sendSamsungCancel(
      account,
      { cc2: 'US', requestId: 'req-1', type: 'ticket', eventId: 'event-123', attempt: 1, now: NOW },
      fetcher,
    );
    for (const type of ['generic', 'giftcard']) {
      await expect(
        sendSamsungUpdate(
          account,
          {
            cc2: 'US',
            requestId: 'req-1',
            type,
            refId,
            state: 'UPDATED',
            attempt: 1,
            now: NOW,
          },
          fetcher,
        ),
      ).rejects.toMatchObject({ kind: 'invalid_request', retryable: false });
    }
    const unsupportedFields = {
      cc2: 'US',
      requestId: 'req-1',
      type: 'loyalty',
      refId,
      state: 'UPDATED' as const,
      fields: 'title',
      attempt: 1,
      now: NOW,
    };
    await expect(sendSamsungUpdate(account, unsupportedFields, fetcher)).rejects.toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      'https://tsapi-card.walletsvc.samsung.com/US/wltex/cards/card123/updates',
      'https://tsapi-card.walletsvc.samsung.com/US/wltex/cards/card123/cancels',
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      card: { type: 'loyalty', data: [{ refId, state: 'UPDATED' }] },
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      card: { type: 'ticket', data: [{ eventId: 'event-123', state: 'CANCELED' }] },
    });
    for (const [index, call] of calls.entries()) {
      expect(call.init.method).toBe('POST');
      expect(call.init.redirect).toBe('manual');
      const headers = new Headers(call.init.headers);
      expect(headers.get('x-smcs-partner-id')).toBe(credentials.partnerId);
      expect(headers.get('x-request-id')).toBe('req-1');
      const jwt = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      const publicKey = await importX509(partner.certificate, 'RS256');
      const signed = await compactVerify(jwt, publicKey, { algorithms: ['RS256'] });
      expect(signed.protectedHeader).toMatchObject({ cty: 'AUTH', ver: '3', utc: NOW });
      expect(JSON.parse(text.decode(signed.payload))).toEqual({
        API: {
          method: 'POST',
          path: `/US/wltex/cards/card123/${index === 0 ? 'updates' : 'cancels'}`,
        },
      });
    }
  });

  it('accepts 2xx for provider-side retirement but not ordinary-update 204', async () => {
    const noContent = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const accepted = (async () => new Response(null, { status: 202 })) as typeof fetch;
    await expect(
      sendSamsungUpdate(
        account,
        {
          cc2: 'US',
          requestId: 'req-1',
          type: 'loyalty',
          refId,
          state: 'DELETED',
          attempt: 1,
          now: NOW,
        },
        noContent,
      ),
    ).resolves.toBeUndefined();
    await expect(
      sendSamsungCancel(
        account,
        {
          cc2: 'US',
          requestId: 'req-1',
          type: 'ticket',
          eventId: 'event-123',
          attempt: 1,
          now: NOW,
        },
        noContent,
      ),
    ).resolves.toBeUndefined();
    await expect(
      sendSamsungUpdate(
        account,
        {
          cc2: 'US',
          requestId: 'req-1',
          type: 'loyalty',
          refId,
          state: 'DELETED',
          attempt: 1,
          now: NOW,
        },
        accepted,
      ),
    ).resolves.toBeUndefined();
    await expect(
      sendSamsungUpdate(
        account,
        {
          cc2: 'US',
          requestId: 'req-1',
          type: 'loyalty',
          refId,
          state: 'UPDATED',
          attempt: 1,
          now: NOW,
        },
        noContent,
      ),
    ).rejects.toMatchObject({ kind: 'not_found', status: 204 });
  });

  it('classifies bounded retries and never exposes provider response bodies', async () => {
    expect(classifySamsungFailure({ status: 204, attempt: 1, now: NOW })).toMatchObject({
      kind: 'not_found',
      retryable: false,
    });
    expect(classifySamsungFailure({ status: 401, attempt: 1, now: NOW })).toMatchObject({
      kind: 'authentication',
      retryable: false,
    });
    expect(
      classifySamsungFailure({ status: 429, attempt: 1, retryAfter: '99999', now: NOW }),
    ).toMatchObject({
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: 300_000,
    });
    expect(classifySamsungFailure({ status: 503, attempt: 3, now: NOW })).toMatchObject({
      kind: 'unavailable',
      retryable: false,
      ambiguous: true,
    });
    expect(classifySamsungFailure({ attempt: 1, now: NOW })).toMatchObject({
      kind: 'network',
      retryable: true,
      ambiguous: true,
    });
    await expect(
      sendSamsungUpdate(
        account,
        {
          cc2: 'US',
          requestId: 'req-1',
          type: 'loyalty',
          refId,
          state: 'UPDATED',
          attempt: 1,
          now: NOW,
        },
        (async () => new Response(null, { status: 204 })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: 'not_found', retryable: false });
    const fetcher = (async () =>
      new Response('private upstream details', { status: 503 })) as typeof fetch;
    try {
      await sendSamsungUpdate(
        account,
        {
          cc2: 'US',
          requestId: 'req-1',
          type: 'loyalty',
          refId,
          state: 'DELETED',
          attempt: 1,
          now: NOW,
        },
        fetcher,
      );
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SamsungNotificationError);
      expect(String(error)).not.toContain('private upstream details');
      expect(error).toMatchObject({ kind: 'unavailable', retryable: true });
    }
    await expect(
      sendSamsungUpdate(
        account,
        {
          cc2: 'US',
          requestId: 'req-1',
          type: 'loyalty',
          refId,
          state: 'DELETED',
          attempt: 3,
          now: NOW,
        },
        (async () => {
          throw new Error('private network details');
        }) as typeof fetch,
      ),
    ).rejects.toMatchObject({ kind: 'network', retryable: false, ambiguous: true });
  });
});
