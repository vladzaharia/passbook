import { compactVerify, importX509 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import {
  probeSamsungActiveTemplate,
  SamsungTemplateError,
  type ValidatedSamsungCredentials,
  validateSamsungCredentials,
} from './samsung.ts';

const NOW = Date.now();
const input = {
  cardType: 'loyalty',
  subType: 'others',
  countryCode: 'US',
  mode: 'live' as const,
  now: NOW,
};
let account: ValidatedSamsungCredentials;
let certificate: string;

beforeAll(async () => {
  const identity = await createFixtureIdentity(undefined, { now: new Date(NOW) });
  certificate = identity.certificate;
  account = await validateSamsungCredentials(
    {
      partnerId: 'partner123',
      certificateId: 'AB12',
      cardId: 'card123',
      partnerPrivateKeyPem: identity.privateKey,
      partnerCertificatePem: identity.certificate,
      samsungCertificatePem: identity.certificate,
    },
    NOW,
  );
}, 30_000);

const template = {
  cardId: 'card123',
  cardType: 'loyalty',
  subType: 'others',
  countryCode: 'US',
  state: 'ACTIVE',
  testingModeOff: 'Y',
};

function response(templateValue: unknown): Response {
  return new Response(JSON.stringify({ resultCode: '0', template: templateValue }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchPage(value: Response): typeof fetch {
  return (async () => value) as typeof fetch;
}

describe('Samsung template evidence', () => {
  it('authenticates the official GET and returns only the exact active template', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (typeof url !== 'string' || !init) throw new Error('invalid test request');
      requests.push({ url, init });
      return response(template);
    }) as typeof fetch;
    const evidence = await probeSamsungActiveTemplate(account, input, fetcher);
    expect(evidence).toEqual({ ...template, verifiedAt: NOW });
    expect(requests.map((request) => request.url)).toEqual([
      'https://tsapi-card.walletsvc.samsung.com/partner/v1/card/template/card123',
    ]);
    const publicKey = await importX509(certificate, 'RS256');
    for (const request of requests) {
      expect(request.init.method).toBe('GET');
      expect(request.init.redirect).toBe('manual');
      expect(request.init.signal).toBeDefined();
      const headers = new Headers(request.init.headers);
      expect(headers.get('x-smcs-partner-id')).toBe('partner123');
      expect(headers.get('x-request-id')).toMatch(/^[a-f0-9]{32}$/);
      const token = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
      const signed = await compactVerify(token, publicKey, { algorithms: ['RS256'] });
      expect(signed.protectedHeader).toMatchObject({
        cty: 'AUTH',
        ver: '3',
        certificateId: 'AB12',
        utc: NOW,
      });
      expect(JSON.parse(new TextDecoder().decode(signed.payload))).toEqual({
        API: { method: 'GET', path: '/partner/v1/card/template/card123' },
      });
    }
  });

  it('accepts the documented plural object label but rejects ambiguous or list responses', async () => {
    await expect(
      probeSamsungActiveTemplate(
        account,
        input,
        fetchPage(
          new Response(
            JSON.stringify({
              resultCode: '0',
              templates: template,
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({ cardId: 'card123', state: 'ACTIVE' });
    await expect(
      probeSamsungActiveTemplate(
        account,
        input,
        fetchPage(
          new Response(
            JSON.stringify({
              resultCode: '0',
              template,
              templates: template,
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      probeSamsungActiveTemplate(
        account,
        input,
        fetchPage(
          new Response(
            JSON.stringify({
              resultCode: '0',
              templates: [template],
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    { ...template, cardId: 'other' },
    { ...template, cardType: 'generic' },
    { ...template, subType: 'wrong' },
    { ...template, countryCode: 'GB' },
    { ...template, state: 'VERIFYING' },
    { ...template, state: 'BLOCKED' },
    { ...template, testingModeOff: 'N' },
    { ...template, testingModeOff: undefined },
  ])('rejects a mismatched or unavailable live template', async (candidate) => {
    await expect(
      probeSamsungActiveTemplate(account, input, fetchPage(response(candidate))),
    ).rejects.toMatchObject({ name: 'SamsungTemplateError', code: 'not_eligible' });
  });

  it('requires ACTIVE and disabled testing mode in test mode as well', async () => {
    const evidence = await probeSamsungActiveTemplate(
      account,
      { ...input, mode: 'test' },
      fetchPage(response(template)),
    );
    expect(evidence).toMatchObject({ state: 'ACTIVE', testingModeOff: 'Y' });
    for (const candidate of [
      { ...template, state: 'VERIFYING' },
      { ...template, testingModeOff: 'N' },
      { ...template, testingModeOff: undefined },
    ])
      await expect(
        probeSamsungActiveTemplate(
          account,
          { ...input, mode: 'test' },
          fetchPage(response(candidate)),
        ),
      ).rejects.toMatchObject({ code: 'not_eligible' });
  });

  it('rejects duplicate object keys, including escaped equivalents, at every depth', async () => {
    const item = JSON.stringify(template);
    const duplicateState = item.replace('"state":"ACTIVE"', '"state":"VERIFYING","state":"ACTIVE"');
    const duplicateCard = item.replace('"cardId":"card123"', '"cardId":"other","cardId":"card123"');
    const bodies = [
      `{"resultCode":"1","resultCode":"0","template":${item}}`,
      `{"resultCode":"0","\\u0072esultCode":"0","template":${item}}`,
      `{"resultCode":"0","template":${duplicateState}}`,
      `{"resultCode":"0","template":${duplicateCard}}`,
      `{"resultCode":"0","template":${item},"template":${item}}`,
      `{"resultCode":"0","extra":{"x":1,"\\u0078":2},"template":${item}}`,
    ];
    for (const body of bodies)
      await expect(
        probeSamsungActiveTemplate(account, input, fetchPage(new Response(body))),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    const quoted = { ...template, title: 'Text with "state":"BLOCKED" and \\\\ characters' };
    await expect(
      probeSamsungActiveTemplate(account, input, fetchPage(response(quoted))),
    ).resolves.toMatchObject({ cardId: 'card123', state: 'ACTIVE' });
  });

  it('rejects malformed, oversized and non-success responses without exposing the body', async () => {
    await expect(
      probeSamsungActiveTemplate(
        account,
        input,
        fetchPage(
          new Response(
            JSON.stringify({
              resultCode: '0',
              template: 'invalid',
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      probeSamsungActiveTemplate(account, input, fetchPage(response([template]))),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      probeSamsungActiveTemplate(account, input, fetchPage(response(null))),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      probeSamsungActiveTemplate(account, input, fetchPage(new Response(null, { status: 302 }))),
    ).rejects.toMatchObject({ code: 'http', status: 302 });
    await expect(
      probeSamsungActiveTemplate(account, input, fetchPage(new Response('x'.repeat(65_537)))),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    try {
      await probeSamsungActiveTemplate(
        account,
        input,
        fetchPage(new Response('private provider data', { status: 503 })),
      );
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SamsungTemplateError);
      expect(error).toMatchObject({ code: 'http', status: 503 });
      expect(String(error)).not.toContain('private provider data');
    }
    await expect(
      probeSamsungActiveTemplate(account, input, (async () => {
        throw new Error('private network data');
      }) as typeof fetch),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
