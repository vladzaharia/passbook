import { describe, expect, it } from 'vitest';
import { RestPaginationSchema } from '../contracts/connection-probe.ts';
import { detectPagination, type PaginationInput } from './detect-pagination.ts';

const ids = (...v: string[]) => v.map((id) => ({ id }));

const detect = (over: Partial<PaginationInput>) =>
  detectPagination({
    url: 'https://api.example.com/v1/things',
    body: {},
    headers: {},
    recordsPointer: '/data',
    count: 2,
    hasIds: true,
    ...over,
  });

/** The R1 fixtures, modelled on public API docs, one per pagination style. */
describe('detectPagination: the six styles', () => {
  it('Stripe: has_more with IDs is a last-id cursor', () => {
    const [top] = detect({
      body: { object: 'list', url: '/v1/customers', data: ids('cus_1'), has_more: true },
    });
    expect(top).toEqual({
      confidence: 'high',
      evidence: 'field:/has_more',
      config: {
        style: 'cursor',
        param: 'starting_after',
        cursorPointer: '',
        hasMorePointer: '/has_more',
        from: 'last-id',
      },
    });
  });

  it('has_more without the Stripe marker is only a low-confidence guess', () => {
    const [top] = detect({ body: { data: ids('a'), has_more: true } });
    expect(top).toMatchObject({ confidence: 'low', config: { style: 'cursor', from: 'last-id' } });
  });

  it('GitHub: the Link header with rel="next"', () => {
    const [top] = detect({
      recordsPointer: '',
      body: ids('a', 'b'),
      headers: {
        link: '<https://api.example.com/v1/repos?page=2>; rel="next", <https://api.example.com/v1/repos?page=9>; rel="last"',
      },
    });
    expect(top).toEqual({
      confidence: 'high',
      evidence: 'header:link',
      config: { style: 'link-header' },
    });
  });

  it('a Link header without next (the last page) is still link-header, with less confidence', () => {
    const [top] = detect({
      recordsPointer: '',
      body: ids('a'),
      headers: { link: '<https://api.example.com/v1/repos?page=1>; rel="first"' },
    });
    expect(top).toMatchObject({ confidence: 'medium', config: { style: 'link-header' } });
  });

  it('HubSpot: paging.next.link and paging.next.after, both', () => {
    const found = detect({
      recordsPointer: '/results',
      body: {
        results: ids('1', '2'),
        paging: { next: { after: '2', link: 'https://api.example.com/v1/crm/contacts?after=2' } },
      },
    });
    expect(found.map((c) => c.config)).toEqual([
      { style: 'next-link', nextPointer: '/paging/next/link' },
      { style: 'cursor', param: 'after', cursorPointer: '/paging/next/after', from: 'body' },
    ]);
    expect(found.every((c) => c.confidence === 'high')).toBe(true);
  });

  it('Airtable: a string offset is a cursor token', () => {
    const [top] = detect({
      recordsPointer: '/records',
      body: { records: ids('rec1'), offset: 'itrA/rec1' },
    });
    expect(top).toEqual({
      confidence: 'high',
      evidence: 'field:/offset',
      config: { style: 'cursor', param: 'offset', cursorPointer: '/offset', from: 'body' },
    });
  });

  it('WooCommerce: X-WP-TotalPages is the page count, with the size the request asks for', () => {
    const [top] = detect({
      url: 'https://api.example.com/v1/products?page=1&per_page=2',
      recordsPointer: '',
      body: ids('1', '2'),
      headers: { 'x-wp-totalpages': '2', 'x-wp-total': '3' },
    });
    expect(top).toEqual({
      confidence: 'high',
      evidence: 'header:x-wp-totalpages',
      config: {
        style: 'page',
        param: 'page',
        start: 1,
        sizeParam: 'per_page',
        size: 2,
        totalPagesHeader: 'X-WP-TotalPages',
      },
    });
  });

  it('page fields in the body: current page, total pages and page size', () => {
    const [top] = detect({
      body: { data: ids('a'), current_page: 1, last_page: 4, per_page: 25 },
    });
    expect(top).toMatchObject({
      confidence: 'high',
      config: {
        style: 'page',
        param: 'page',
        start: 1,
        sizeParam: 'per_page',
        size: 25,
        totalPagesPointer: '/last_page',
      },
    });
  });

  it('a page number counted from 0 sets start 0', () => {
    const [top] = detect({ body: { data: ids('a'), page: 0, total_pages: 3 } });
    expect(top?.config).toMatchObject({ style: 'page', start: 0 });
  });

  it('limit, offset and total in the body', () => {
    const [top] = detect({ body: { data: ids('1', '2'), total: 5, limit: 2, offset: 0 } });
    expect(top).toEqual({
      confidence: 'high',
      evidence: 'field:/offset',
      config: {
        style: 'offset',
        param: 'offset',
        sizeParam: 'limit',
        size: 2,
        totalPointer: '/total',
      },
    });
  });

  it('an offset parameter in the request is enough, with the page size it uses', () => {
    const [top] = detect({
      url: 'https://api.example.com/v1/m?skip=0&limit=50',
      body: { data: ids('a') },
    });
    expect(top).toMatchObject({
      confidence: 'medium',
      evidence: 'query:skip',
      config: { style: 'offset', param: 'skip', sizeParam: 'limit', size: 50 },
    });
  });

  it('a next URL in a HAL _links object', () => {
    const [top] = detect({
      recordsPointer: '/_embedded/items',
      body: { _embedded: { items: ids('a') }, _links: { next: { href: '/v1/items?page=2' } } },
    });
    expect(top?.config).toEqual({ style: 'next-link', nextPointer: '/_links/next/href' });
  });

  it('GraphQL-style pageInfo.endCursor with hasNextPage', () => {
    const [top] = detect({
      recordsPointer: '/items',
      body: { items: ids('a'), pageInfo: { endCursor: 'abc', hasNextPage: true } },
    });
    expect(top?.config).toEqual({
      style: 'cursor',
      param: 'after',
      cursorPointer: '/pageInfo/endCursor',
      hasMorePointer: '/pageInfo/hasNextPage',
      from: 'body',
    });
  });

  it('a null cursor (the last page) still names the field, with less confidence', () => {
    const [top] = detect({ body: { data: ids('a'), next_cursor: null } });
    expect(top).toMatchObject({
      confidence: 'medium',
      config: { cursorPointer: '/next_cursor', param: 'cursor' },
    });
  });

  it('nothing found is none', () => {
    expect(detect({ body: { data: ids('a') } })).toEqual([
      { confidence: 'low', config: { style: 'none' }, evidence: 'none' },
    ]);
  });
});

describe('detectPagination: ordering and limits', () => {
  it('returns at most 3, most confident first, and every config passes the contract', () => {
    const found = detect({
      url: 'https://api.example.com/v1/m?page=1',
      body: {
        data: ids('a'),
        next_url: '/v1/m?page=2',
        next_cursor: 'c2',
        page: 1,
        total_pages: 3,
        total: 9,
        limit: 3,
        offset: 0,
      },
      headers: { link: '<https://api.example.com/v1/m?page=2>; rel="next"' },
    });
    expect(found).toHaveLength(3);
    expect(found.map((c) => c.config.style)).toEqual(['link-header', 'next-link', 'cursor']);
    for (const c of found) expect(RestPaginationSchema.safeParse(c.config).success).toBe(true);
  });

  it('does not read paging fields out of the records', () => {
    const found = detect({
      body: { data: [{ id: 'a', next_cursor: 'x', page: 3, total_pages: 9 }] },
    });
    expect(found[0]?.config).toEqual({ style: 'none' });
  });

  it('ignores a next field that is not a URL or path', () => {
    const found = detect({ body: { data: ids('a'), next: 'Next steps' } });
    expect(found[0]?.config).toEqual({ style: 'none' });
  });
});
