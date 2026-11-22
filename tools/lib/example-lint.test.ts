import { describe, expect, it } from 'vitest';
import { exampleFailures } from './example-lint.ts';
import type { Doc } from './openapi-diff.ts';

const UUID7 = '0193a1b2-7c00-7000-8000-0000000000c1';

/** A document with one key-callable operation per response example. */
const docWith = (examples: Record<string, { value: unknown; schema?: object }>): Doc => ({
  paths: Object.fromEntries(
    Object.entries(examples).map(([id, { value, schema }]) => [
      `/${id}`,
      {
        get: {
          operationId: id,
          security: [{ apiKey: [] }],
          responses: {
            '200': { content: { 'application/json': { schema: schema ?? {}, example: value } } },
          },
        },
      },
    ]),
  ),
  components: { schemas: {} },
});
const run = (value: unknown, schema?: object): string[] =>
  exampleFailures(docWith({ 'a.getA': { value, schema } }));

describe('exampleFailures', () => {
  it('accepts an example that reads like real traffic', () => {
    expect(
      run({ id: UUID7, name: 'Front desk', createdAt: 1795521600000, email: 'ada@example.com' }),
    ).toEqual([]);
  });

  it('rejects the literal filler values', () => {
    expect(run({ slug: 'example' })).toEqual(['a.getA response.slug: "example" is filler']);
    expect(run({ kind: 'string' })).toEqual(['a.getA response.kind: "string" is filler']);
    expect(run({ key: 'example-key' })).toEqual(['a.getA response.key: "example-key" is filler']);
    expect(run({ config: { example: 1 } })).toEqual([
      'a.getA response.config.example: the key "example" is filler',
    ]);
  });

  it('rejects a person name in a field that is not a person', () => {
    expect(run({ name: 'Ada Example' })).toEqual([
      'a.getA response.name: person name "Ada Example" in a field that is not a person',
    ]);
    expect(run({ holder: { name: 'Ada Example' } })).toEqual([]);
  });

  it('rejects an empty {} where the schema has properties', () => {
    const schema = { properties: { passJson: { type: 'object', properties: { a: {} } } } };
    expect(run({ passJson: {} }, schema)).toEqual([
      'a.getA response.passJson: an empty {} where the schema has properties',
    ]);
    expect(run({ meta: {} }, { properties: { meta: { type: 'object' } } })).toEqual([]);
  });

  it('rejects truncated and non-v7 UUIDs in id fields', () => {
    expect(run({ id: '0193a1b2-7c00-7000-8000-0a1b2c3d' })).toEqual([
      'a.getA response.id: "0193a1b2-7c00-7000-8000-0a1b2c3d" is a truncated UUID',
    ]);
    expect(run({ orgId: '3f9c2d6a-5b1e-4c7a-9d20-8a41e6b7c0f2' })).toEqual([
      'a.getA response.orgId: "3f9c2d6a-5b1e-4c7a-9d20-8a41e6b7c0f2" is not a UUIDv7',
    ]);
  });

  it('rejects a time of 1 and a run of one character', () => {
    expect(run({ validFrom: 1 })).toEqual([
      'a.getA response.validFrom: time 1 is not a plausible millisecond time',
    ]);
    expect(run({ secret: 'whsec_11111111111111111111' })).toEqual([
      'a.getA response.secret: "whsec_11111111111111111111" repeats one character',
    ]);
  });

  it('rejects an email outside example.com and a word from another world', () => {
    expect(run({ email: 'help@acme.test' })).toEqual([
      'a.getA response.email: "help@acme.test" is from another sample world',
      'a.getA response.email: email "help@acme.test" is not at example.com',
    ]);
    expect(run({ title: 'Harbor Night' })).toEqual([
      'a.getA response.title: "Harbor Night" is from another sample world',
    ]);
  });

  it('rejects one regex-sample code reused by four operations', () => {
    const schema = { properties: { code: { type: 'string', pattern: '^[A-Z0-9]{8}$' } } };
    const ops = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((n) => [`x.get${n}`, { value: { code: 'K7M2QX9P' }, schema }]),
    );
    expect(exampleFailures(docWith(ops))).toEqual([
      '"K7M2QX9P" is a regex sample reused by 4 operations',
    ]);
    expect(exampleFailures(docWith({ 'x.geta': ops['x.geta'] as never }))).toEqual([]);
  });
});
