import { describe, expect, it } from 'vitest';
import { waitFromHeaders } from '../lib/http.ts';
import { decodeCursor, encodeCursor, MAX_VALUE_CHARS } from './cursor.ts';
import { drain, harness, NOW, type Reply } from './harness.ts';
import connector from './index.ts';

const base = { baseUrl: 'https://api.example.com/v1' };
const ids = (...v: string[]) => v.map((id) => ({ id }));

describe('long cursors and links keep paging', () => {
  it('follows a 700-character next link to page 2', async () => {
    const long = `/v1/m?page=2&skiptoken=${'t'.repeat(700)}`;
    const { ctx, calls } = harness(
      { ...base, list: { path: '/m', pagination: { style: 'next-link', nextPointer: '/next' } } },
      {},
      (u) =>
        u.searchParams.get('page') === '2'
          ? { body: { items: ids('b') } }
          : { body: { items: ids('a'), next: long } },
    );
    const out = await drain(ctx);
    expect(out.refs).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
  });

  it('follows a 700-character cursor, and resumes a long v1 feed cursor', async () => {
    const token = 'c'.repeat(700);
    const { ctx } = harness(
      { ...base, list: { path: '/m', pagination: { style: 'cursor' } } },
      {},
      (u) =>
        u.searchParams.get('cursor') === token
          ? { body: { items: ids('b') } }
          : { body: { items: ids('a'), cursor: token } },
    );
    expect((await drain(ctx)).refs).toEqual(['a', 'b']);
    const resumed = await connector.listChanges?.(ctx, token);
    expect(resumed?.changes.map((c) => c.ref)).toEqual(['b']);
  });

  it('refuses a value over the limit with a named, permanent error and no stack overflow', async () => {
    for (const size of [MAX_VALUE_CHARS + 1, 200_000]) {
      const { ctx } = harness(
        { ...base, list: { path: '/m', pagination: { style: 'cursor' } } },
        {},
        () => ({ body: { items: ids('a'), cursor: 'x'.repeat(size) } }),
      );
      await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
        code: 'INVALID_PAYLOAD',
        permanent: true,
        reason: 'CURSOR_TOO_LONG',
      });
    }
    expect(() => encodeCursor({ p: { u: `/${'u'.repeat(MAX_VALUE_CHARS)}` } })).toThrow();
  });
});

describe('listing integrity', () => {
  it('follows an empty page that still says there is more', async () => {
    const pages: Record<string, Reply> = {
      '': { body: { data: ids('a'), more: true, next: 'p2' } },
      p2: { body: { data: [], more: true, next: 'p3' } },
      p3: { body: { data: ids('c'), more: false } },
    };
    const { ctx } = harness(
      {
        ...base,
        list: {
          path: '/m',
          recordsPointer: '/data',
          pagination: {
            style: 'cursor',
            param: 'after',
            cursorPointer: '/next',
            hasMorePointer: '/more',
          },
        },
      },
      {},
      (u) => pages[u.searchParams.get('after') ?? ''] ?? { body: { data: [] } },
    );
    expect((await drain(ctx)).refs).toEqual(['a', 'c']);
  });

  it('stops when a page repeats the one before, and starts the listing over', async () => {
    const { ctx, logs } = harness(
      {
        ...base,
        list: {
          path: '/m',
          recordsPointer: '/data',
          pagination: { style: 'page', param: 'page', start: 1 },
          incremental: { param: 'since', field: '/at', format: 'unix' },
        },
      },
      {},
      () => ({
        body: {
          data: [
            { id: 'a', at: 5 },
            { id: 'b', at: 6 },
          ],
        },
      }),
    );
    const out = await drain(ctx);
    expect(out.pages).toBe(2);
    expect(logs).toContain('rest.repeat_page');
    expect(decodeCursor(out.cursor).state).toEqual({ p: null });
  });

  it('never moves the mark past the clock', async () => {
    const { ctx } = harness(
      {
        ...base,
        list: { path: '/m', incremental: { param: 'since', field: '/at', format: 'unix-ms' } },
      },
      {},
      () => ({ body: { items: [{ id: 'a', at: NOW + 20 * 3_600_000 }] } }),
    );
    const res = await connector.listChanges?.(ctx, null);
    expect(decodeCursor(res?.cursor ?? null).state.h).toBe(NOW);
  });

  it('refuses a page whose changes would not fit a Workflows step', async () => {
    const fat = 'x'.repeat(1200);
    const { ctx } = harness({ ...base, list: { path: '/m' } }, {}, () => ({
      body: { items: Array.from({ length: 800 }, (_, i) => ({ id: String(i), fat })) },
    }));
    await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
      permanent: true,
      reason: 'PAGE_TOO_LARGE',
    });
    expect(connector.defaults.maxResponseBytes).toBeLessThanOrEqual(512 * 1024);
  });
});

describe('stored links and credentials', () => {
  const link = { style: 'next-link', nextPointer: '/next' };

  it('keeps a same-origin link with a leading double slash on the origin', async () => {
    const { ctx, calls } = harness({ ...base, list: { path: '/m', pagination: link } }, {}, (u) =>
      u.pathname === '//evil.com/x'
        ? { body: { items: ids('b') } }
        : { body: { items: ids('a'), next: 'https://api.example.com//evil.com/x' } },
    );
    expect((await drain(ctx)).refs).toEqual(['a', 'b']);
    expect(calls[1]?.url).toBe('https://api.example.com//evil.com/x');
  });

  it('drops an echoed credential under any name or case from the stored link', async () => {
    const { ctx } = harness(
      {
        ...base,
        auth: { type: 'query', queryParam: 'api_key' },
        list: { path: '/m', pagination: link },
      },
      { queryValue: 'SECRET-KEY' },
      () => ({ body: { items: ids('a'), next: '/v1/m?page=2&API_KEY=SECRET-KEY&key=SECRET-KEY' } }),
    );
    const res = await connector.listChanges?.(ctx, null);
    expect(decodeCursor(res?.cursor ?? null).state.p?.u).toBe('/v1/m?page=2');
  });

  it('sends a credential header once, whatever the case of a static header', async () => {
    const { ctx, calls } = harness(
      {
        ...base,
        auth: { type: 'header', headerName: 'X-Token-Id' },
        headers: [{ name: 'X-Site', value: 'a' }],
      },
      { headerValue: 'k' },
      () => ({ body: { a: 1 } }),
    );
    await connector.fetchRecord(ctx, 'x');
    expect(calls[0]?.headers).toMatchObject({ 'x-token-id': 'k', 'x-site': 'a' });
  });
});

describe('config refuses credentials, and bad rows surface as CONFIG', () => {
  const asHeader = (name: string, value = 'x') => ({ ...base, headers: [{ name, value }] });
  const asQuery = (name: string, value = '1') => ({
    ...base,
    list: { path: '/l', query: [{ name, value }] },
  });
  const accepted = (config: object) => connector.configSchema.safeParse(config).success;

  it.each([
    'keyword',
    'keywords',
    'author',
    'author_id',
    'authored_after',
    'sort_key',
    'partition_key',
    'passes',
    'bypass_cache',
    'token_type',
    'page[size]',
    'updatedSince',
  ])('accepts the parameter name %s', (name) => {
    expect(accepted(asQuery(name))).toBe(true);
  });

  it.each([
    'X-Author',
    'X-Bypass-Cache',
    'X-Passthrough',
    'X-Keycloak-Realm',
    'X-Compass-Workspace',
    'Idempotency-Key',
    'Notion-Version',
    'X-Site-Id',
  ])('accepts the header name %s', (name) => {
    expect(accepted(asHeader(name))).toBe(true);
  });

  it.each([
    'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12',
    'pending_customer_verification_required',
    'token based',
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    '2022-06-28',
    'active',
  ])('accepts the value %s', (value) => {
    expect(accepted(asHeader('X-Custom', value))).toBe(true);
    expect(accepted(asQuery('q', value))).toBe(true);
  });

  it.each([
    'X-Authorization',
    'X-Auth',
    'Authentication',
    'Authorization',
    'X-Password',
    'X-Credentials',
    'X-Session',
    'X-Session-Id',
    'X-Api-Key',
    'X-Auth-Token',
    'Cookie',
    'Proxy-Foo',
    'X-Signature',
    'X-Access-Key',
    'X-Secret-Key',
    'X-Bearer',
  ])('refuses the header name %s', (name) => {
    expect(accepted(asHeader(name))).toBe(false);
  });

  it.each([
    'api_key',
    'apiKey',
    'access_token',
    'token',
    'secret',
    'client_secret',
    'password',
    'key',
    'session',
    'signature',
    'private_key',
    'auth',
  ])('refuses the parameter name %s', (name) => {
    expect(accepted(asQuery(name))).toBe(false);
  });

  it.each([
    'Bearer eyJhbGciOiJIUzI1NiJ9',
    'Basic dXNlcjpwYXNzd29yZA==',
    // Built from parts: a whole token literal is what secret scanners look for.
    ['sk_live_', 'abcdefghijklmnop'].join(''),
    'sk-abcdefghijklmnopqrstuvwx',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0abcdefghijkl',
    ['glpat-', 'abcdefghijklmnopqrst'].join(''),
    'xoxb-1234567890-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'SG.abcdefghijklmnop.qrstuvwxyz0123456789',
    'AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
    ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'].join(
      '.',
    ),
    'Xk3fA9qLmN2pR7sTuV8wYz1BcD4eGhJ6',
  ])('refuses the value %s', (value) => {
    expect(accepted(asHeader('X-Custom', value))).toBe(false);
    expect(accepted(asQuery('q', value))).toBe(false);
  });

  it('a stored row that does not migrate is a permanent CONFIG error', () => {
    expect(() => connector.migrate?.(1, { baseUrl: 'not a url' })).toThrowError(
      expect.objectContaining({ code: 'CONFIG', permanent: true }),
    );
  });

  it('a list-only connection cannot fetch a single record', async () => {
    const { ctx, calls } = harness({ ...base, list: { path: '/m' } }, {}, () => ({ body: {} }));
    await expect(connector.fetchRecord(ctx, 'a')).rejects.toMatchObject({
      code: 'CONFIG',
      permanent: true,
    });
    expect(calls).toHaveLength(0);
  });

  it('reads a fractional Retry-After', () => {
    expect(waitFromHeaders(new Headers({ 'retry-after': '1.5' }), NOW)).toBe(1500);
  });
});

describe('page size is measured in bytes, and repeats in whole pages', () => {
  it('counts UTF-8 bytes against the step limit', async () => {
    // 400 refs of 400 CJK characters: about 340,000 characters but over 950,000 UTF-8 bytes.
    const cjk = '漢'.repeat(400);
    const { ctx } = harness({ ...base, list: { path: '/m' } }, {}, () => ({
      body: { items: Array.from({ length: 400 }, (_, i) => ({ id: `${i}${cjk}` })) },
    }));
    await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
      reason: 'PAGE_TOO_LARGE',
    });
  });

  const paged = (data: (u: URL) => { id: string }[]) =>
    harness(
      {
        ...base,
        list: { path: '/m', recordsPointer: '/data', pagination: { style: 'page', start: 1 } },
      },
      {},
      (u) => ({ body: { data: data(u) } }),
    );

  it('a record that sits on two single-record pages in a row does not end the listing', async () => {
    const pages: Record<string, { id: string }[]> = {
      '1': ids('x'),
      '2': ids('x'),
      '3': ids('y'),
      '4': [],
    };
    const { ctx } = paged((u) => pages[u.searchParams.get('page') ?? ''] ?? []);
    expect((await drain(ctx)).refs).toEqual(['x', 'x', 'y']);
  });

  it('a one-record page that repeats twice ends the listing', async () => {
    const { ctx, logs } = paged(() => ids('x'));
    expect((await drain(ctx)).refs).toEqual(['x', 'x', 'x']);
    expect(logs).toContain('rest.repeat_page');
  });

  it('pages with the same ends but different middles are not repeats', async () => {
    const pages: Record<string, { id: string }[]> = {
      '1': ids('a', 'b', 'c'),
      '2': ids('a', 'z', 'c'),
      '3': [],
    };
    const { ctx } = paged((u) => pages[u.searchParams.get('page') ?? ''] ?? []);
    expect((await drain(ctx)).refs).toEqual(['a', 'b', 'c', 'a', 'z', 'c']);
  });

  it('a longer page that repeats ends the listing at once', async () => {
    const { ctx } = paged(() => ids('a', 'b'));
    expect((await drain(ctx)).refs).toEqual(['a', 'b', 'a', 'b']);
  });
});

describe('R2 review: header and parameter rules', () => {
  const base = { baseUrl: 'https://api.example.com/v1' };
  it('refuses method-override headers and a _method parameter', () => {
    for (const name of ['X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override']) {
      expect(
        connector.configSchema.safeParse({ ...base, headers: [{ name, value: 'DELETE' }] }).success,
      ).toBe(false);
    }
    expect(
      connector.configSchema.safeParse({
        ...base,
        list: { path: '/m', query: [{ name: '_method', value: 'DELETE' }] },
      }).success,
    ).toBe(false);
  });

  it('totalPagesHeader may not name a credential-like header', () => {
    const page = (totalPagesHeader: string) =>
      connector.configSchema.safeParse({
        ...base,
        list: { path: '/m', pagination: { style: 'page', totalPagesHeader } },
      }).success;
    expect(page('X-WP-TotalPages')).toBe(true);
    for (const bad of [
      'X-Auth-Token',
      'WWW-Authenticate',
      'X-Subject-Token',
      'X-CSRF-Token',
      'Location',
      'Set-Cookie',
    ]) {
      expect(page(bad)).toBe(false);
    }
  });
});
