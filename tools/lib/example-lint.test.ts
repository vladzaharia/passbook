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
    expect(run({ tok: 'tok_11111111111111111111' })).toEqual([
      'a.getA response.tok: "tok_11111111111111111111" repeats one character',
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

  it('rejects filler words and case variants', () => {
    expect(run({ a: 'EXAMPLE' })).toEqual(['a.getA response.a: "EXAMPLE" is filler']);
    expect(run({ a: 'Lorem ipsum dolor' })).toEqual([
      'a.getA response.a: "Lorem ipsum dolor" is filler text',
    ]);
    expect(run({ a: 'TODO later' })).toEqual(['a.getA response.a: "TODO later" is filler text']);
    expect(run({ a: 'Jane Doe' })).toEqual(['a.getA response.a: "Jane Doe" is filler text']);
    expect(run({ a: 'changeme' })).toEqual([
      'a.getA response.a: "changeme" is filler',
      'a.getA response.a: "changeme" is filler text',
    ]);
  });

  it('rejects zero-padded ids that are not in the world', () => {
    expect(run({ id: '0193a1b2-7c00-7000-8000-0000000000ff' })).toEqual([
      'a.getA response.id: "0193a1b2-7c00-7000-8000-0000000000ff" is a zero-padded id',
    ]);
  });

  it('rejects one id under two entity keys in one object', () => {
    expect(run({ id: UUID7, templateId: UUID7 })).toEqual([
      `a.getA response.templateId: the id ${UUID7} is also the self id in this object`,
    ]);
    expect(run({ createdBy: UUID7, ownerUserId: UUID7 })).toEqual([]);
  });

  it('rejects objects whose numbers are all 1 or all 3', () => {
    expect(run({ a: 3, b: 3, c: 3 })).toEqual([
      'a.getA response: every number is 3, which reads as filler',
    ]);
    expect(run({ a: 1, b: 1, c: 1 })).toEqual([
      'a.getA response: every number is 1, which reads as filler',
    ]);
    expect(run({ a: 3, b: 12, c: 3 })).toEqual([]);
  });

  it('rejects secret shapes a scanner reports, and accepts test-mode keys', () => {
    const live = `pb_live_${'k3Qx9Zt2'}_${'x7Kp'.repeat(11).slice(0, 43)}`;
    expect(run({ t: live })).toEqual([
      `a.getA response.t: "${live.slice(0, 24)}…" looks like a live-prefixed key`,
    ]);
    expect(run({ t: 'ya29.a0AfH6SMBx' })).toEqual([
      'a.getA response.t: "ya29.a0AfH6SMBx…" looks like a Google OAuth token',
    ]);
    expect(run({ t: 'AKIAIOSFODNN7EXAMPLE' })).toHaveLength(1);
    expect(run({ t: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc' })).toHaveLength(1);
    expect(run({ t: `pb_test_k3Qx9Zt2_${'b9'.repeat(21)}x` })).toEqual([]);
    expect(run({ t: 'whsec_demo4f9a0c' })).toEqual([]);
    expect(run({ t: 'whsec_4f9a0c31d7' })).toHaveLength(1);
    expect(run({ t: '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----' })).toEqual([]);
    expect(
      run({
        t: `-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkq'.repeat(4)}\n-----END PRIVATE KEY-----`,
      }),
    ).toHaveLength(1);
  });

  it('rejects a secret that does not match its prefix', () => {
    const key = {
      prefix: 'k3Qx9Zt2',
      secretPrefix: 'pb_test_k3Qx9Zt2',
      secret: 'pb_test_q8Wm3Lr5_x',
    };
    expect(run(key)).toEqual(['a.getA response.secret: does not start with "pb_test_k3Qx9Zt2"']);
    expect(run({ prefix: 'pb_test_k3Qx9Zt2', secretPrefix: 'pb_test_k3Qx9Zt2' })).toEqual([
      'a.getA response.prefix: equals secretPrefix; the prefix is the part after the label',
    ]);
  });
});
