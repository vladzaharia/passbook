import { describe, expect, it } from 'vitest';
import { breakingChanges, type Doc } from './openapi-diff.ts';

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
});
