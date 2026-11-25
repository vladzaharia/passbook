import { describe, expect, it } from 'vitest';
import { ProbeConfigSchema, RestPaginationSchema } from './connection-probe.ts';

describe('RestPaginationSchema', () => {
  it.each([
    { style: 'none' },
    { style: 'cursor', param: 'starting_after', cursorPointer: '/data/-1/id', from: 'last-id' },
    { style: 'next-link', nextPointer: '/links/next' },
    { style: 'link-header' },
    { style: 'page', param: 'page[number]', start: 1, sizeParam: 'per_page', size: 100 },
    { style: 'offset', param: '$skip', sizeParam: '$top', size: 50, totalPointer: '/total' },
  ])('accepts $style', (p) => {
    expect(RestPaginationSchema.parse(p)).toMatchObject(p);
  });
  it('reads a cursor from the body unless told otherwise', () => {
    const p = RestPaginationSchema.parse({
      style: 'cursor',
      param: 'cursor',
      cursorPointer: '/next',
    });
    expect(p).toMatchObject({ from: 'body' });
  });
  it.each([
    { style: 'scroll' },
    { style: 'page', param: 'page', start: 2 },
    { style: 'offset', param: 'offset', sizeParam: 'limit', size: 1001 },
    { style: 'cursor', param: 'a b', cursorPointer: '/next' },
    { style: 'next-link', nextPointer: 'next' },
  ])('refuses %j', (p) => {
    expect(RestPaginationSchema.safeParse(p).success).toBe(false);
  });
});

describe('ProbeConfigSchema', () => {
  const probe = { orgId: 'o1', config: {}, target: 'list' };
  it('probes the REST connector only', () => {
    expect(ProbeConfigSchema.safeParse({ ...probe, connectorType: 'http-json' }).success).toBe(
      true,
    );
    expect(ProbeConfigSchema.safeParse({ ...probe, connectorType: 'csv-url' }).success).toBe(false);
  });
});
