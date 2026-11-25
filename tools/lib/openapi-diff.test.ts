import { describe, expect, it } from 'vitest';
import {
  approvedRemovalFailures,
  breakingChanges,
  type Doc,
  withoutApprovedRemovals,
} from './openapi-diff.ts';

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

describe('withoutApprovedRemovals', () => {
  const gone: Doc = { paths: {} };
  const approval = {
    op: 'GET /a',
    operationId: 'a.getA',
    date: '2026-11-24',
    reason: 'owner decision 2026-11-24',
  };

  it('sets aside a removal the owner approved, and nothing else', () => {
    const broken = breakingChanges(doc(inline), gone);
    expect(broken).toEqual(['GET /a: operation removed']);
    expect(withoutApprovedRemovals(broken, [approval])).toEqual([]);
    expect(withoutApprovedRemovals(broken, [{ ...approval, op: 'GET /b' }])).toEqual(broken);
  });

  it('keeps a field removal on an approved operation that still exists', () => {
    const fieldGone = breakingChanges(doc(inline), doc({ type: 'object', properties: {} }));
    expect(withoutApprovedRemovals(fieldGone, [approval])).toEqual(fieldGone);
  });
});

describe('approvedRemovalFailures', () => {
  const gone: Doc = { paths: {} };
  const approval = {
    op: 'GET /a',
    operationId: 'a.getA',
    date: '2026-11-24',
    reason: 'owner decision 2026-11-24',
  };

  it('accepts an operation the base serves and the next document drops', () => {
    expect(approvedRemovalFailures(doc(inline), gone, [approval])).toEqual([]);
  });

  it('fails an entry when the base serves the operation under another id', () => {
    expect(
      approvedRemovalFailures(doc(inline), gone, [{ ...approval, operationId: 'a.other' }])[0],
    ).toMatch(/not a.other/);
  });

  it('passes an entry for an operation both documents already lack (base after the removal)', () => {
    expect(approvedRemovalFailures(gone, gone, [approval])).toEqual([]);
  });

  it('fails an entry whose operation is still served', () => {
    expect(approvedRemovalFailures(doc(inline), doc(inline), [approval])[0]).toMatch(
      /still in the document/,
    );
  });
});
