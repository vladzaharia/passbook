import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkDeprecation, deprecationHeaders } from './deprecation.ts';
import { handleError } from './error-handler.ts';
import { AppError } from './errors.ts';
import { createRouter, register } from './openapi.ts';
import { withDeprecationNotes } from './openapi-document.ts';

const DEPRECATED = { since: '2026-11-25', sunset: '2027-11-25', guide: 'visitor-management' };
const ENV = { PUBLIC_BASE_URL: 'https://passbook.mobile/' };

function app() {
  const router = createRouter();
  router.onError(handleError);
  register(
    router,
    'test',
    {
      method: 'post',
      path: '/old',
      summary: 'old',
      public: true,
      deprecated: DEPRECATED,
      body: z.object({ n: z.number() }),
      response: z.object({ ok: z.boolean() }),
    },
    (c) => {
      if (c.req.valid('json').n === 0) throw new AppError('GONE_FOR_GOOD', 409, 'No.');
      return c.json({ ok: true });
    },
  );
  register(router, 'test', { method: 'get', path: '/new', summary: 'new', public: true }, (c) =>
    c.json({ ok: true }),
  );
  return router;
}

const post = (n: unknown) =>
  app().request(
    '/old',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n }),
    },
    ENV,
  );

const HEADERS = {
  deprecation: '@1795564800',
  sunset: 'Thu, 25 Nov 2027 00:00:00 GMT',
  link: '<https://passbook.mobile/developers/guides/visitor-management>; rel="deprecation"; type="text/html"',
};
const seen = (res: Response) => ({
  deprecation: res.headers.get('deprecation'),
  sunset: res.headers.get('sunset'),
  link: res.headers.get('link'),
});

describe('deprecated operation', () => {
  it('sends the three headers on success', async () => {
    const res = await post(1);
    expect(res.status).toBe(200);
    expect(seen(res)).toEqual(HEADERS);
  });

  it('sends them on a thrown problem+json', async () => {
    const res = await post(0);
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(seen(res)).toEqual(HEADERS);
  });

  it('sends them on a validation failure', async () => {
    const res = await post('x');
    expect(res.status).toBe(422);
    expect(seen(res)).toEqual(HEADERS);
  });

  it('leaves other operations alone', async () => {
    const res = await app().request('/new', {}, ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBeNull();
    expect(res.headers.get('sunset')).toBeNull();
  });

  it('marks the document', () => {
    const doc = app().getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
    }) as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> };
    expect(doc.paths['/old']?.post).toMatchObject({ deprecated: true, 'x-sunset': '2027-11-25' });
    expect(doc.paths['/new']?.get?.deprecated).toBeUndefined();
  });

  it('prefixes the description with the end date', () => {
    const doc = withDeprecationNotes({
      paths: {
        '/a': {
          get: { deprecated: true, 'x-sunset': '2027-11-25', description: 'Lists.' },
          post: { deprecated: true, 'x-sunset': '2027-11-25' },
          put: { description: 'Kept.' },
        },
      },
    }) as { paths: Record<string, Record<string, { description?: string }>> };
    expect(doc.paths['/a']?.get?.description).toBe('Deprecated: ends 25 Nov 2027. Lists.');
    expect(doc.paths['/a']?.post?.description).toBe('Deprecated: ends 25 Nov 2027.');
    expect(doc.paths['/a']?.put?.description).toBe('Kept.');
  });

  it('builds the headers from the base url', () => {
    expect(deprecationHeaders(DEPRECATED, 'https://x.test').Link).toContain(
      '<https://x.test/developers/guides/visitor-management>',
    );
  });

  it('refuses bad dates at registration', () => {
    expect(() =>
      register(
        createRouter(),
        'test',
        {
          method: 'get',
          path: '/bad',
          summary: 'bad',
          public: true,
          deprecated: { ...DEPRECATED, sunset: '2026-01-01' },
        },
        (c) => c.json({}),
      ),
    ).toThrow(/sunset must follow since/);
  });
});

describe('checkDeprecation', () => {
  it('needs a year between since and sunset', () => {
    expect(() => checkDeprecation('x', DEPRECATED)).not.toThrow();
    expect(() => checkDeprecation('x', { ...DEPRECATED, sunset: '2027-11-24' })).toThrow(
      /at least 365 days/,
    );
  });
});
