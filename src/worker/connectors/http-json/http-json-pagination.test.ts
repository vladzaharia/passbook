import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.ts';
import { drain, harness, type Reply } from './harness.ts';
import connector from './index.ts';
import { nextFromLinkHeader } from './pagination.ts';

const base = { baseUrl: 'https://api.example.com/v1' };
const ids = (...v: string[]) => v.map((id) => ({ id }));

/** Serves `pages` in order by a key read from each request's URL. */
function serve(key: (url: URL) => string | null, pages: Record<string, Reply>) {
  return (url: URL): Reply => pages[key(url) ?? ''] ?? { body: [] };
}

describe('pagination styles, with fixtures modelled on public API docs', () => {
  it('Stripe: starting_after the last id while has_more', async () => {
    const { ctx, calls } = harness(
      {
        ...base,
        list: {
          path: '/customers',
          query: [{ name: 'limit', value: '2' }],
          recordsPointer: '/data',
          pagination: {
            style: 'cursor',
            param: 'starting_after',
            from: 'last-id',
            hasMorePointer: '/has_more',
          },
        },
      },
      {},
      serve((u) => u.searchParams.get('starting_after'), {
        '': { body: { object: 'list', data: ids('cus_1', 'cus_2'), has_more: true } },
        cus_2: { body: { object: 'list', data: ids('cus_3'), has_more: false } },
      }),
    );
    const out = await drain(ctx);
    expect(out.refs).toEqual(['cus_1', 'cus_2', 'cus_3']);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.com/v1/customers?limit=2',
      'https://api.example.com/v1/customers?limit=2&starting_after=cus_2',
    ]);
    // A full listing starts over next run.
    expect(decodeCursor(out.cursor).state.p).toBeNull();
  });

  it('GitHub: follows the Link header rel="next"', async () => {
    const link = (n: number, last: number) =>
      `<https://api.example.com/v1/repos?page=${n}>; rel="next", <https://api.example.com/v1/repos?page=${last}>; rel="last"`;
    const { ctx, calls } = harness(
      {
        ...base,
        list: { path: '/repos', recordsPointer: '', pagination: { style: 'link-header' } },
      },
      {},
      serve((u) => u.searchParams.get('page'), {
        '': { body: ids('a', 'b'), headers: { link: link(2, 3) } },
        '2': { body: ids('c'), headers: { link: link(3, 3) } },
        '3': {
          body: ids('d'),
          headers: { link: '<https://api.example.com/v1/repos?page=1>; rel="first"' },
        },
      }),
    );
    const out = await drain(ctx);
    expect(out.refs).toEqual(['a', 'b', 'c', 'd']);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.com/v1/repos',
      'https://api.example.com/v1/repos?page=2',
      'https://api.example.com/v1/repos?page=3',
    ]);
  });

  it('HubSpot: paging.next.after into the after parameter', async () => {
    const { ctx } = harness(
      {
        ...base,
        list: {
          path: '/crm/contacts',
          recordsPointer: '/results',
          pagination: { style: 'cursor', param: 'after', cursorPointer: '/paging/next/after' },
        },
      },
      {},
      serve((u) => u.searchParams.get('after'), {
        '': { body: { results: ids('1', '2'), paging: { next: { after: '2', link: 'x' } } } },
        '2': { body: { results: ids('3') } },
      }),
    );
    expect((await drain(ctx)).refs).toEqual(['1', '2', '3']);
  });

  it('Airtable: the offset token in the body, until it is absent', async () => {
    const { ctx } = harness(
      {
        ...base,
        list: {
          path: '/tbl',
          recordsPointer: '/records',
          pagination: { style: 'cursor', param: 'offset', cursorPointer: '/offset' },
        },
      },
      {},
      serve((u) => u.searchParams.get('offset'), {
        '': { body: { records: ids('rec1'), offset: 'itrA/rec1' } },
        'itrA/rec1': { body: { records: ids('rec2'), offset: 'itrB/rec2' } },
        'itrB/rec2': { body: { records: ids('rec3') } },
      }),
    );
    expect((await drain(ctx)).refs).toEqual(['rec1', 'rec2', 'rec3']);
  });

  it('WooCommerce: page numbers until X-WP-TotalPages', async () => {
    const { ctx, calls } = harness(
      {
        ...base,
        list: {
          path: '/products',
          recordsPointer: '',
          pagination: {
            style: 'page',
            param: 'page',
            start: 1,
            sizeParam: 'per_page',
            size: 2,
            totalPagesHeader: 'X-WP-TotalPages',
          },
        },
      },
      {},
      serve((u) => u.searchParams.get('page'), {
        '1': { body: ids('1', '2'), headers: { 'x-wp-totalpages': '2' } },
        '2': { body: ids('3'), headers: { 'x-wp-totalpages': '2' } },
      }),
    );
    const out = await drain(ctx);
    expect(out.refs).toEqual(['1', '2', '3']);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/products?page=1&per_page=2');
  });

  it('page numbers from 0 stop on an empty page when no total is given', async () => {
    const { ctx, calls } = harness(
      { ...base, list: { path: '/p', pagination: { style: 'page', start: 0 } } },
      {},
      serve((u) => u.searchParams.get('page'), {
        '0': { body: { items: ids('a') } },
        '1': { body: { items: ids('b') } },
        '2': { body: { items: [] } },
      }),
    );
    expect((await drain(ctx)).refs).toEqual(['a', 'b']);
    expect(calls).toHaveLength(3);
  });

  it('limit and offset with a total in the body', async () => {
    const { ctx, calls } = harness(
      {
        ...base,
        list: {
          path: '/m',
          recordsPointer: '/data',
          pagination: {
            style: 'offset',
            param: 'offset',
            sizeParam: 'limit',
            size: 2,
            totalPointer: '/total',
          },
        },
      },
      {},
      serve((u) => u.searchParams.get('offset'), {
        '0': { body: { data: ids('1', '2'), total: 5 } },
        '2': { body: { data: ids('3', '4'), total: 5 } },
        '4': { body: { data: ids('5'), total: 5 } },
      }),
    );
    const out = await drain(ctx);
    expect(out.refs).toEqual(['1', '2', '3', '4', '5']);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toBe('https://api.example.com/v1/m?offset=2&limit=2');
  });

  it('a next link in the body is relative to the request and keeps its own query', async () => {
    const { ctx, calls } = harness(
      {
        ...base,
        list: {
          path: '/m',
          query: [{ name: 'status', value: 'active' }],
          pagination: { style: 'next-link', nextPointer: '/links/next' },
        },
      },
      {},
      serve((u) => u.searchParams.get('page'), {
        '': { body: { items: ids('a'), links: { next: '/v1/m?status=active&page=2' } } },
        '2': { body: { items: ids('b'), links: { next: null } } },
      }),
    );
    expect((await drain(ctx)).refs).toEqual(['a', 'b']);
    expect(calls[1]?.url).toBe('https://api.example.com/v1/m?status=active&page=2');
  });

  it('parses Link headers with several relations and odd spacing', () => {
    expect(nextFromLinkHeader('<https://x/a>; rel="prev", <https://x/b>;rel=next')).toBe(
      'https://x/b',
    );
    expect(nextFromLinkHeader('<https://x/a>; rel="prev next"')).toBe('https://x/a');
    expect(nextFromLinkHeader('<https://x/a>; rel="last"')).toBeNull();
    expect(nextFromLinkHeader(null)).toBeNull();
  });
});

describe('pagination stops and limits', () => {
  const nextLink = {
    ...base,
    list: { path: '/m', pagination: { style: 'next-link', nextPointer: '/next' } },
  };

  it('refuses a next link on another host without calling it', async () => {
    const { ctx, calls } = harness(nextLink, {}, () => ({
      body: { items: ids('a'), next: 'https://evil.example/steal' },
    }));
    await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
      code: 'CONFIG',
      permanent: true,
      reason: 'OFF_ORIGIN',
    });
    expect(calls).toHaveLength(1);
  });

  it('refuses a Link header on another port, another scheme or a look-alike host', async () => {
    for (const next of [
      'https://api.example.com:8443/x',
      'http://api.example.com/x',
      'https://api.example.com.evil.example/x',
      'https://api.example.com@evil.example/x',
    ]) {
      const { ctx, calls } = harness(
        { ...base, list: { path: '/m', pagination: { style: 'link-header' } } },
        {},
        () => ({ body: { items: ids('a') }, headers: { link: `<${next}>; rel="next"` } }),
      );
      await expect(connector.listChanges?.(ctx, null)).rejects.toMatchObject({
        reason: 'OFF_ORIGIN',
      });
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses a stored cursor that points off the origin', async () => {
    const { ctx, calls } = harness(nextLink, {}, () => ({ body: { items: [] } }));
    const cursor = encodeCursor({ p: { u: 'https://evil.example/x' } });
    await expect(connector.listChanges?.(ctx, cursor)).rejects.toMatchObject({
      reason: 'OFF_ORIGIN',
    });
    expect(calls).toHaveLength(0);
  });

  it('keeps the credential out of the stored cursor and out of the next-link walk', async () => {
    const { ctx, calls } = harness(
      {
        ...base,
        auth: { type: 'query', queryParam: 'api_key' },
        list: { path: '/m', pagination: { style: 'next-link', nextPointer: '/next' } },
      },
      { queryValue: 'SECRET-KEY' },
      serve((u) => u.searchParams.get('page'), {
        '': { body: { items: ids('a'), next: '/v1/m?page=2&api_key=SECRET-KEY' } },
        '2': { body: { items: ids('b') } },
      }),
    );
    const first = await connector.listChanges?.(ctx, null);
    expect(first?.cursor).toBeDefined();
    expect(first?.cursor).not.toContain('SECRET');
    expect(
      atob((first?.cursor ?? '').slice(3).replaceAll('-', '+').replaceAll('_', '/')),
    ).not.toContain('SECRET');
    expect(decodeCursor(first?.cursor ?? null).state.p).toEqual({ u: '/v1/m?page=2', k: 1 });
    await connector.listChanges?.(ctx, first?.cursor ?? null);
    expect(calls[0]?.url).toContain('api_key=SECRET-KEY');
    expect(new URL(calls[1]?.url ?? '').searchParams.get('api_key')).toBe('SECRET-KEY');
  });

  it('stops on a repeated link, a repeated cursor and an empty page', async () => {
    const loop = harness(nextLink, {}, () => ({
      body: { items: ids('a'), next: '/v1/m?page=2' },
    }));
    const first = await connector.listChanges?.(loop.ctx, null);
    expect(first?.hasMore).toBe(true);
    const second = await connector.listChanges?.(loop.ctx, first?.cursor ?? null);
    expect(second?.hasMore).toBe(false);

    const empty = harness(nextLink, {}, () => ({ body: { items: [], next: '/v1/m?page=9' } }));
    expect((await connector.listChanges?.(empty.ctx, null))?.hasMore).toBe(false);
  });

  it('ends a full listing at maxPages, logs it and leaves the high-water mark alone', async () => {
    const { ctx, logs } = harness(
      {
        ...base,
        list: {
          path: '/m',
          maxPages: 3,
          pagination: { style: 'offset', size: 1 },
          incremental: { param: 'since', field: '/at', format: 'unix' },
        },
      },
      {},
      (u) => ({ body: { items: [{ id: u.searchParams.get('offset'), at: 1_000 }] } }),
    );
    const out = await drain(ctx);
    expect(out.pages).toBe(3);
    expect(out.refs).toEqual(['0', '1', '2']);
    expect(logs).toContain('rest.max_pages');
    expect(decodeCursor(out.cursor).state).toEqual({ p: null });
  });

  it('a feed cut at maxPages resumes from the next page', async () => {
    const { ctx } = harness(
      {
        ...base,
        list: {
          path: '/m',
          listing: 'feed',
          maxPages: 2,
          pagination: { style: 'offset', size: 1 },
        },
      },
      {},
      (u) => ({ body: { items: ids(u.searchParams.get('offset') ?? '') } }),
    );
    const out = await drain(ctx);
    expect(out.refs).toEqual(['0', '1']);
    expect(decodeCursor(out.cursor).state.p).toEqual({ n: 2 });
    expect((await drain(ctx, out.cursor)).refs).toEqual(['2', '3']);
  });

  it('refuses a page of more than 1,000 records and a cursor over 2 KB', async () => {
    const big = harness({ ...base, list: { path: '/m' } }, {}, () => ({
      body: { items: Array.from({ length: 1001 }, (_, i) => ({ id: String(i) })) },
    }));
    await expect(connector.listChanges?.(big.ctx, null)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    const long = harness(
      { ...base, list: { path: '/m', pagination: { style: 'cursor' } } },
      {},
      () => ({ body: { items: ids('a'), cursor: 'x'.repeat(590) } }),
    );
    expect(await connector.listChanges?.(long.ctx, null)).toMatchObject({ hasMore: true });
    expect(() => encodeCursor({ p: { c: 'x'.repeat(2000) } })).toThrow();
  });
});

describe('the cursor across runs and failures', () => {
  const offset = {
    ...base,
    list: { path: '/m', recordsPointer: '/data', pagination: { style: 'offset', size: 2 } },
  };
  const pages = (u: URL): Reply => {
    const o = Number(u.searchParams.get('offset'));
    return { body: { data: ids(...[o, o + 1].filter((n) => n < 5).map(String)) } };
  };

  it('a failed page is asked for again from the saved cursor, and the listing is the same', async () => {
    let fail = true;
    const { ctx, calls } = harness(offset, {}, (u) =>
      u.searchParams.get('offset') === '2' && fail ? { status: 503 } : pages(u),
    );
    const first = await connector.listChanges?.(ctx, null);
    await expect(connector.listChanges?.(ctx, first?.cursor ?? null)).rejects.toMatchObject({
      code: 'UPSTREAM',
    });
    fail = false;
    const resumed = await drain(ctx, first?.cursor ?? null);
    expect(resumed.refs).toEqual(['2', '3', '4']);
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual([
      '0',
      '2',
      '2',
      '4',
      '5',
    ]);
  });

  it('a full listing starts at page one next run; a feed continues at its end', async () => {
    const full = harness(offset, {}, pages);
    const done = await drain(full.ctx);
    expect(done.refs).toHaveLength(5);
    expect((await drain(full.ctx, done.cursor)).refs).toHaveLength(5);

    const feed = harness({ ...offset, list: { ...offset.list, listing: 'feed' } }, {}, pages);
    const tail = await drain(feed.ctx);
    expect(decodeCursor(tail.cursor).state.p).toEqual({ n: 5 });
    expect((await drain(feed.ctx, tail.cursor)).refs).toEqual([]);
  });

  it('a damaged r2 cursor restarts the listing and says so', async () => {
    const { ctx, logs } = harness(offset, {}, pages);
    const res = await connector.listChanges?.(ctx, 'r2.%%%not-base64%%%');
    expect(res?.changes.map((c) => c.ref)).toEqual(['0', '1']);
    expect(logs).toContain('rest.cursor_reset');
  });
});
