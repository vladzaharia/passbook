import { describe, expect, it } from 'vitest';
import { breakingChanges, changes, type Doc } from './openapi-diff.ts';

const op = (schema: unknown) => ({
  operationId: 'a.getA',
  responses: { 200: { content: { 'application/json': { schema } } } },
});
const doc = (schema: unknown, components: object = {}): Doc => ({
  paths: { '/a': { get: op(schema) } },
  components: { schemas: components },
});
const inline = { type: 'object', properties: { x: { type: 'string' } } };

describe('breakingChanges', () => {
  it('reads a nullable named schema as the named schema', () => {
    const named = doc(
      { allOf: [{ $ref: '#/components/schemas/A' }, { type: ['object', 'null'] }] },
      { A: inline },
    );
    expect(breakingChanges(doc(inline), named)).toEqual([]);
  });

  it('still reports a removed field', () => {
    const gone = doc({ type: 'object', properties: {} });
    expect(breakingChanges(doc(inline), gone)).toEqual(['GET /a 200.x: field removed']);
  });

  it('reports a request object that now refuses unknown keys', () => {
    const post = (schema: unknown): Doc => ({
      paths: {
        '/a': {
          post: {
            operationId: 'a.postA',
            requestBody: { content: { 'application/json': { schema } } },
            responses: {},
          },
        },
      },
    });
    const open = { type: 'object', properties: { t: { type: 'object', properties: {} } } };
    const closed = {
      type: 'object',
      properties: { t: { type: 'object', properties: {}, additionalProperties: false } },
    };
    expect(breakingChanges(post(open), post(closed))).toEqual([
      'POST /a body.t: unknown keys now refused',
    ]);
    expect(breakingChanges(post(closed), post(closed))).toEqual([]);
  });
});

describe('removal at a Sunset', () => {
  const gone = (extra: object): Doc => ({
    paths: { '/a': { get: { operationId: 'a.getA', ...extra } } },
  });
  const empty: Doc = { paths: {} };

  it('refuses removing an operation that was not deprecated', () => {
    expect(breakingChanges(gone({}), empty, '2030-01-01')).toEqual(['GET /a: operation removed']);
    expect(breakingChanges(gone({ deprecated: true }), empty, '2030-01-01')).toEqual([
      'GET /a: operation removed',
    ]);
  });

  it('refuses removing a deprecated one before its x-sunset', () => {
    const was = gone({ deprecated: true, 'x-deprecated': '2026-11-25', 'x-sunset': '2027-11-25' });
    expect(breakingChanges(was, empty, '2027-11-24')[0]).toMatch(/removed before its Sunset/);
  });

  it('refuses a removal whose window was under 365 days or unknown', () => {
    const short = gone({
      deprecated: true,
      'x-deprecated': '2027-01-01',
      'x-sunset': '2027-11-25',
    });
    expect(breakingChanges(short, empty, '2027-12-01')[0]).toMatch(
      /without 365 days.*on 2027-12-01/,
    );
    const bare = gone({ deprecated: true, 'x-sunset': '2027-11-25' });
    expect(breakingChanges(bare, empty, '2027-12-01')[0]).toMatch(/without 365 days/);
  });

  it('names a removal on or after the x-sunset', () => {
    const was = gone({ deprecated: true, 'x-deprecated': '2026-11-25', 'x-sunset': '2027-11-25' });
    expect(breakingChanges(was, empty, '2027-11-25')[0]).toMatch(/operation removed at its Sunset/);
    expect(changes(was, empty, '2028-01-01')).toMatchObject([{ class: 'breaking', op: 'GET /a' }]);
  });
});
