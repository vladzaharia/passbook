import { describe, expect, it } from 'vitest';
import type { Doc } from './openapi-diff.ts';
import { coverage, ratchetFailures, type SdkName, type SdkNames } from './openapi-ratchet.ts';

const KEY = [{ apiKey: ['passes:read'] }, { session: [] }];
const op = (id: string, over: Record<string, unknown> = {}) => ({
  operationId: id,
  tags: ['passes'],
  security: KEY,
  ...over,
});
const doc = (ops: Record<string, Record<string, unknown>>): Doc => ({
  paths: Object.fromEntries(Object.entries(ops).map(([p, o]) => [p, { get: o }])),
});
const names: SdkNames = { 'passes.getPasses': { resource: 'passes', method: 'list' } };
const base = doc({ '/api/v1/passes': op('passes.getPasses') });
const run = (
  next: Doc,
  nextNames: SdkNames,
  baseNames: SdkNames | null = names,
  b: Doc | null = base,
) => ratchetFailures({ base: b, next, baseNames, nextNames });

describe('ratchet', () => {
  it('passes unchanged', () => expect(run(base, names)).toEqual([]));

  it('fails a rename, a removal and true to false', () => {
    expect(run(base, { 'passes.getPasses': { resource: 'passes', method: 'all' } })[0]).toMatch(
      /renamed/,
    );
    expect(run(base, {}).join()).toMatch(/passes.getPasses: name removed/);
    const hidden = { ...names['passes.getPasses'], sdk: false, reason: 'x' } as SdkName;
    expect(run(base, { 'passes.getPasses': hidden }).join()).toMatch(/true to false/);
  });

  it('lets an approved removal drop its frozen name, and only that one', () => {
    const none: Doc = { paths: {} };
    const gone = (approvedIds: string[]) =>
      ratchetFailures({ base, next: none, baseNames: names, nextNames: {}, approvedIds });
    expect(gone(['passes.getPasses'])).toEqual([]);
    expect(gone(['passes.other']).join()).toMatch(/passes.getPasses: name removed/);
    // An approval does not cover an operation that is still in the document.
    expect(
      ratchetFailures({
        base,
        next: base,
        baseNames: names,
        nextNames: {},
        approvedIds: ['passes.getPasses'],
      }).join(),
    ).toMatch(/name removed/);
  });

  it('allows false to true', () => {
    const was = {
      'passes.getPasses': { resource: 'passes', method: 'list', sdk: false, reason: 'r' },
    };
    expect(run(base, names, was)).toEqual([]);
  });

  it('fails an operation without a name, and a name without an operation', () => {
    const next = doc({ '/api/v1/passes': op('passes.getPasses'), '/api/v1/x': op('x.getX') });
    expect(run(next, names).join()).toMatch(/add x.getX to docs\/api\/sdk-names.json/);
    expect(run(base, { ...names, 'x.getX': { resource: 'x', method: 'list' } }).join()).toMatch(
      /x.getX: name has no operation/,
    );
  });

  it('checks the shape of names', () => {
    const bad = (n: SdkNames[string], path = '/api/v1/passes') =>
      run(doc({ [path]: op('passes.getPasses') }), { 'passes.getPasses': n }, null, null);
    expect(bad({ resource: 'Passes', method: 'list' })).toHaveLength(1);
    expect(bad({ resource: 'a.b.c', method: 'list' }).join()).toMatch(/2 levels/);
    expect(bad({ resource: 'passes', method: 'getAll' }).join()).toMatch(/HTTP verb/);
    expect(bad({ resource: 'passes', method: 'deleteAll' }).join()).toMatch(/HTTP verb/);
    expect(bad({ resource: 'passes', method: 'listByOrg' }).join()).toMatch(/By/);
    expect(bad({ resource: 'passes', method: 'delete' })).toEqual([]);
    expect(bad({ resource: 'orgs', method: 'list' }, '/api/v1/platform/orgs').join()).toMatch(
      /platform/,
    );
    expect(bad({ resource: 'passes', method: 'list', sdk: false }).join()).toMatch(/reason/);
  });

  it('fails a tag that is not kebab-case', () => {
    const next = doc({ '/api/v1/passes': op('passes.getPasses', { tags: ['wallet platform'] }) });
    expect(run(next, names).join()).toMatch(/kebab/);
  });

  it('fails a coverage drop per operation, not in total', () => {
    const covered = (id: string) => op(id, { description: 'Lists.' });
    const two = {
      'a.getA': { resource: 'a', method: 'list' },
      'b.getB': { resource: 'b', method: 'list' },
    };
    const b = doc({ '/a': covered('a.getA'), '/b': op('b.getB') });
    const next = doc({ '/a': op('a.getA'), '/b': covered('b.getB') });
    const out = run(next, two, two, b);
    expect(out).toEqual(['a.getA: coverage dropped, description was set']);
  });

  it('requires every flag on a new key-callable operation', () => {
    const next = doc({ '/api/v1/passes': op('passes.getPasses'), '/api/v1/y': op('y.getY') });
    const out = run(next, { ...names, 'y.getY': { resource: 'y', method: 'list' } });
    expect(out).toEqual(['y.getY: new key-callable operation needs description']);
  });

  it('counts the flags over key-callable operations', () => {
    const body = { content: { 'application/json': { schema: { $ref: '#/x' }, example: {} } } };
    const d = doc({
      '/a': op('a.getA', { description: 'd', responses: { 200: body } }),
      '/b': op('b.getB', { security: [{ session: [] }] }),
    });
    expect(coverage(d)).toMatchObject({
      description: [1, 1],
      responseExample: [1, 1],
      namedResponse: [1, 1],
      requestExample: [0, 0],
    });
  });
});

describe('ratchet at a Sunset', () => {
  const dep = (sunset: string) =>
    doc({ '/api/v1/passes': op('passes.getPasses', { deprecated: true, 'x-sunset': sunset }) });
  const gone = doc({});
  const go = (b: Doc, on: string) =>
    ratchetFailures({ base: b, next: gone, baseNames: names, nextNames: {}, on });

  it('lets a name go with its operation on or after the Sunset', () => {
    expect(go(dep('2027-11-25'), '2027-11-25')).toEqual([]);
    expect(go(dep('2027-11-25'), '2028-01-01')).toEqual([]);
  });

  it('keeps names frozen before the Sunset and for operations never deprecated', () => {
    expect(go(dep('2027-11-25'), '2027-11-24').join()).toMatch(/name removed/);
    expect(go(base, '2030-01-01').join()).toMatch(/name removed/);
  });

  it('refuses dropping the name while the operation stays', () => {
    const out = ratchetFailures({
      base: dep('2026-12-01'),
      next: dep('2026-12-01'),
      baseNames: names,
      nextNames: {},
      on: '2027-01-01',
    });
    expect(out.join()).toMatch(/name removed/);
  });
});
