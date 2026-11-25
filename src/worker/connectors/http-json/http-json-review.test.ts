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
  it.each([
    { headers: [{ name: 'X-Authorization', value: 'x' }] },
    { headers: [{ name: 'X-Auth', value: 'x' }] },
    { headers: [{ name: 'Authentication', value: 'x' }] },
    { headers: [{ name: 'X-Password', value: 'x' }] },
    { headers: [{ name: 'X-Credentials', value: 'x' }] },
    { headers: [{ name: 'X-Session', value: 'x' }] },
    { headers: [{ name: 'X-Custom', value: 'Bearer eyJhbGciOiJIUzI1NiJ9' }] },
    { headers: [{ name: 'X-Custom', value: 'sk_live_abcdefghijklmnop' }] },
    { headers: [{ name: 'X-Custom', value: 'a'.repeat(40) }] },
    { list: { path: '/l', query: [{ name: 'api_key', value: '1' }] } },
    { list: { path: '/l', query: [{ name: 'access_token', value: '1' }] } },
    {
      list: {
        path: '/l',
        query: [{ name: 'q', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }],
      },
    },
  ])('rejects %j', (extra) => {
    expect(connector.configSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });

  it('accepts ordinary headers and parameters, a UUID included', () => {
    const ok = connector.configSchema.safeParse({
      ...base,
      headers: [
        { name: 'Notion-Version', value: '2022-06-28' },
        { name: 'X-Site-Id', value: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' },
      ],
      list: {
        path: '/l',
        query: [
          { name: 'status', value: 'active' },
          { name: 'limit', value: '100' },
        ],
      },
    });
    expect(ok.success).toBe(true);
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
