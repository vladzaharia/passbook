import { describe, expect, it } from 'vitest';
import { exampleFailures } from './example-lint.ts';
import { pem } from './example-world.ts';
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

  it('rejects an empty {} where the schema requires properties, not a sparse record', () => {
    const schema = {
      properties: { passJson: { type: 'object', properties: { a: {} }, required: ['a'] } },
    };
    expect(run({ passJson: {} }, schema)).toEqual([
      'a.getA response.passJson: an empty {} where the schema has properties',
    ]);
    expect(run({ meta: {} }, { properties: { meta: { type: 'object' } } })).toEqual([]);
    const sparse = { properties: { overrides: { type: 'object', properties: { paper: {} } } } };
    expect(run({ overrides: {} }, sparse)).toEqual([]);
    // An untyped field holds a value; an empty map is fine.
    const data = { properties: { fields: { type: 'object', additionalProperties: {} } } };
    expect(run({ fields: { tier: {} } }, data)).toEqual([
      'a.getA response.fields.tier: an empty {} where a value belongs',
    ]);
    expect(run({ fields: {} }, data)).toEqual([]);
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
    expect(run({ a: 3, b: 3, c: 3 }).sort()).toEqual([
      'a.getA response: every number is 3, which reads as filler',
      'a.getA response: three sibling numbers are all 3, which reads as filler',
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
    expect(run({ t: `pb_test_k3Qx9Zt2_${'b9'.repeat(21)}` })).toEqual([]);
    expect(run({ t: 'whsec_demo_northwind_4f9a0c' })).toEqual([]);
    expect(run({ t: 'whsec_4f9a0c31d7' })).toHaveLength(1);
    expect(run({ t: pem('PRIVATE KEY') })).toEqual([]);
    expect(
      run({
        t: pem('PRIVATE KEY').replace('…', 'MIIEvQIBADANBgkq'.repeat(4)),
      }),
    ).toHaveLength(1);
  });

  it('rejects a secret that does not match its prefix', () => {
    const key = {
      prefix: 'k3Qx9Zt2',
      secretPrefix: 'pb_test_k3Qx9Zt2',
      secret: 'pb_test_p7Wm4Hn8',
    };
    expect(run(key)).toEqual(['a.getA response.secret: does not start with "pb_test_k3Qx9Zt2"']);
    expect(run({ prefix: 'pb_test_k3Qx9Zt2', secretPrefix: 'pb_test_k3Qx9Zt2' })).toEqual([
      'a.getA response.prefix: equals secretPrefix; the prefix is the part after the label',
    ]);
  });

  it('rejects a value that is just its field name', () => {
    expect(run({ orgSlug: 'orgSlug' })).toEqual([
      'a.getA response.orgSlug: "orgSlug" is just the field name',
    ]);
    expect(run({ csrf_token: 'CsrfToken' })).toHaveLength(1);
    expect(run({ method: 'GET' })).toEqual([]);
  });

  it('reads at, serverNow and *On as times', () => {
    for (const key of ['at', 'serverNow', 'createdOn', 'validUntil'])
      expect(run({ [key]: 12 })).toEqual([
        `a.getA response.${key}: time 12 is not a plausible millisecond time`,
      ]);
  });

  it('rejects fields that cannot all be true', () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { lastSuccessAt: 1795521600000, lastFailureAt: 1795521600000 },
        'lastSuccessAt and lastFailureAt are the same instant',
      ],
      [
        { opensAt: 1795521600000, closesAt: 1795521600000 },
        'opensAt (1795521600000) must be before closesAt (1795521600000)',
      ],
      [
        { validFrom: 1795521600000, validUntil: 1795500000000 },
        'validFrom (1795521600000) must be before validUntil (1795500000000)',
      ],
      [{ status: 'active', closedAt: 1795521600000 }, 'closedAt is set on an active record'],
      [
        { state: 'delivered', nextAt: 1795521600000, lastStatus: 200 },
        'nextAt schedules another attempt on a delivered record',
      ],
      [
        {
          state: 'delivered',
          nextAt: 1795522500000,
          lastAttemptAt: 1795521600000,
          lastStatus: 200,
        },
        'nextAt schedules another attempt on a delivered record',
      ],
      [{ state: 'delivered', lastStatus: null }, 'a delivered record has no lastStatus'],
      [{ state: 'delivered', replays: 30 }, 'replays 30 is too many for one delivery'],
      [{ recordsSeen: 29, recordsFailed: 31 }, 'recordsFailed (31) exceeds recordsSeen (29)'],
      [{ outcome: 'unchanged', passesChanged: 16 }, 'passesChanged is 16 on an unchanged run'],
      [{ total: 128, done: 20, failed: 26 }, 'the parts add up to 46, not total 128'],
      [
        { durationMs: 7, attempts: 7, count: 7 },
        'three sibling numbers are all 7, which reads as filler',
      ],
    ];
    for (const [value, why] of cases) expect(run(value)).toEqual([`a.getA response: ${why}`]);
    expect(
      run({ opensAt: 1795521600000, closesAt: 1795600000000, status: 'active', closedAt: null }),
    ).toEqual([]);
  });

  it('rejects an HTTP status under 100, a pending record with finishedAt, a failure with no code, updatedAt before createdAt', () => {
    expect(run({ status: 7 })).toEqual(['a.getA response: status 7 is not an HTTP status']);
    expect(run({ lastStatus: 200, httpStatus: 42 })).toEqual([
      'a.getA response: httpStatus 42 is not an HTTP status',
    ]);
    expect(run({ state: 'pending', finishedAt: 1795521600000 })).toEqual([
      'a.getA response: finishedAt is set on a pending record',
    ]);
    expect(run({ state: 'failed', errorCode: null })).toEqual([
      'a.getA response: a failed record has no errorCode',
    ]);
    expect(run({ createdAt: 1795521600000, updatedAt: 1795500000000 })).toEqual([
      'a.getA response: updatedAt is before createdAt',
    ]);
  });

  it('rejects an id that is also the id of a differently shaped object in the same example', () => {
    const tag = { id: UUID7, type: { id: UUID7, name: 'Wristband' }, name: 'Tag 14' };
    expect(run(tag)).toEqual([
      `a.getA response.type.id: the id ${UUID7} is also the id of the example`,
    ]);
    // The same entity shown twice is fine.
    const twice = { items: [{ id: UUID7, name: 'a' }], active: { id: UUID7, name: 'a' } };
    expect(run(twice)).toEqual([]);
  });

  it('rejects an unchanged run that created things, counts that do not add up, and empty values', () => {
    expect(run({ outcome: 'unchanged', passesCreated: 19 })).toEqual([
      'a.getA response: passesCreated is 19 on an unchanged run',
    ]);
    expect(
      run({
        records: 35,
        counts: { create: 15, update: 38, unchanged: 11, skipped: 7, errors: 0 },
      }),
    ).toEqual(['a.getA response: counts add up to 71, not records 35']);
    expect(
      run({ records: 10, counts: { create: 4, update: 3, unchanged: 2, skipped: 1, errors: 0 } }),
    ).toEqual([]);
    expect(run({ key: 'tier', value: {}, default: {} }).sort()).toEqual([
      'a.getA response.default: is an empty object',
      'a.getA response.value: is an empty object',
    ]);
    expect(run({ detail: { externalId: 'booking_8841' } })).toEqual([]);
  });

  it('rejects the org name on something that is not the org', () => {
    expect(run({ zones: [{ name: 'Northwind Climbing' }] })).toEqual([
      'a.getA response.zones[0].name: the org name is the name of something that is not the org',
    ]);
    expect(
      exampleFailures(docWith({ 'orgs.getOrg': { value: { name: 'Northwind Climbing' } } })),
    ).toEqual([]);
    expect(run({ slug: 'northwind-climbing', name: 'Northwind Climbing' })).toEqual([]);
  });

  it('rejects one name for two kinds of thing, but not a person or a pass named for its template', () => {
    const doc = docWith({
      'x.getScanners': { value: { scanners: [{ name: 'Front desk' }] } },
      'x.getPlaces': { value: { places: [{ name: 'Front desk' }] } },
    });
    expect(exampleFailures(doc)).toEqual([
      '"Front desk" is the name of more than one kind of thing: place, scanner',
    ]);
    const people = docWith({
      'x.getA': { value: { staff: [{ name: 'Sam Rivera' }] } },
      'x.getB': { value: { admin: { name: 'Sam Rivera' } } },
    });
    expect(exampleFailures(people)).toEqual([]);
    const passes = docWith({
      'x.getP': { value: { passes: [{ title: 'Day pass' }] } },
      'x.getT': { value: { templates: [{ name: 'Day pass' }] } },
    });
    expect(exampleFailures(passes)).toEqual([]);
  });

  it('lets one registered sentence repeat: the same event shows the same note everywhere', () => {
    const same = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((n) => [
        `scan-events.get${n}`,
        { value: { note: 'Doors open 30 minutes early for members.' } },
      ]),
    );
    expect(exampleFailures(docWith(same))).toEqual([]);
  });

  it('rejects an error reason on a healthy, ok or active record, except the APNs probe', () => {
    expect(run({ health: 'healthy', reason: 'BadCertificate' })).toEqual([
      'a.getA response: reason is an error on a healthy record',
    ]);
    expect(run({ state: 'ok', reason: 'ok' })).toEqual([]);
    expect(run({ state: 'failing', reason: 'BadCertificate' })).toEqual([]);
    // A probe with a dummy token is healthy when Apple rejects the token (identities/apns-probe.ts).
    expect(run({ health: 'healthy', status: 400, reason: 'BadDeviceToken' })).toEqual([]);
  });
});
