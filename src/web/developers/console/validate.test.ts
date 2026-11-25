import { describe, expect, it } from 'vitest';
import type { RunSchema } from './types.ts';
import { validate } from './validate.ts';

const schema: RunSchema = {
  type: 'object',
  required: ['templateId', 'input'],
  properties: {
    templateId: { type: 'string', minLength: 1 },
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 5 },
        points: { type: 'integer', minimum: 0 },
      },
    },
    tier: { enum: ['Silver', 'Gold'] },
    email: { type: 'string', format: 'email' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    serial: { type: 'string', pattern: '^[A-Z]+$' },
    either: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    maybe: { type: 'string', nullable: true },
  },
};

const msgs = (v: unknown) => validate(schema, v as never).map((i) => `${i.path} ${i.message}`);

describe('validate', () => {
  it('accepts a body that fits', () => {
    expect(
      msgs({ templateId: 't', input: { name: 'Ada', points: 3 }, tier: 'Gold', maybe: null }),
    ).toEqual([]);
  });
  it('names each missing required field', () => {
    expect(msgs({})).toEqual(['templateId is required', 'input is required']);
  });
  it('checks types, bounds, enums, formats, patterns and array limits at their paths', () => {
    expect(
      msgs({
        templateId: '',
        input: { name: 'toolong', points: -1 },
        tier: 'Bronze',
        email: 'nope',
        serial: 'abc',
        tags: ['a', 'b', 'c', 1],
        either: true,
      }),
    ).toEqual([
      'templateId min 1 characters',
      'input.name max 5 characters',
      'input.points must be at least 0',
      'tier must be one of "Silver", "Gold"',
      'email must be an email address',
      'tags allows at most 2 items',
      'tags[3] must be string',
      'serial has the wrong format',
      'either does not match any allowed shape',
    ]);
  });
  it('treats a number with no fraction as an integer and a string as not', () => {
    expect(validate({ type: 'integer' }, 2.5)).toHaveLength(1);
    expect(validate({ type: 'number' }, 2)).toHaveLength(0);
    expect(validate({ type: 'integer' }, '2')).toHaveLength(1);
  });
  it('words the array size limits in the singular for 1', () => {
    const msg = (schema: RunSchema, v: unknown[]) => validate(schema, v as never)[0]?.message;
    expect(msg({ type: 'array', minItems: 1 }, [])).toBe('needs at least 1 item');
    expect(msg({ type: 'array', minItems: 2 }, [1])).toBe('needs at least 2 items');
    expect(msg({ type: 'array', maxItems: 1 }, [1, 2])).toBe('allows at most 1 item');
    expect(msg({ type: 'array', maxItems: 2 }, [1, 2, 3])).toBe('allows at most 2 items');
  });
});

describe('a template input schema', () => {
  const closed: RunSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { startsAt: { type: 'string', format: 'date-time' } },
  };
  it('names a field the schema does not take', () => {
    expect(validate(closed, { startsAt: '2026-12-04T18:00:00-08:00', extra: 1 })).toEqual([
      { path: 'extra', message: 'is not a field of this schema' },
    ]);
    expect(validate({ ...closed, additionalProperties: true }, { extra: 1 })).toEqual([]);
  });
  it('wants a date and time with an offset', () => {
    expect(validate(closed, { startsAt: '2026-12-04T18:00:00-08:00' })).toEqual([]);
    expect(validate(closed, { startsAt: '2026-12-04T18:00:00Z' })).toEqual([]);
    for (const bad of ['2026-12-04', '2026-12-04T18:00', '2026-02-30T18:00:00Z', 'soon'])
      expect(validate(closed, { startsAt: bad }).map((i) => i.path)).toEqual(['startsAt']);
  });
});
