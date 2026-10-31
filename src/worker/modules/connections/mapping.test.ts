import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../platform/errors.ts';
import { applyMapping, validateMapping } from './mapping.ts';

const record = {
  name: ' Alex ',
  tier: 'G',
  active: true,
  joined: '2024-03-05T10:20:30Z',
  epoch: 1_700_000_000,
  nested: { code: 'abc' },
  nothing: null,
};

describe('applyMapping', () => {
  it('passes the record through without a mapping', () => {
    expect(applyMapping(null, { a: 1 })).toEqual({ a: 1 });
  });

  it('reads pointers and bare names', () => {
    const out = applyMapping(
      { memberName: { from: 'name' }, code: { from: '/nested/code' } },
      record,
    );
    expect(out).toEqual({ memberName: ' Alex ', code: 'abc' });
  });

  it('omits fields whose source is missing or null', () => {
    const out = applyMapping(
      {
        a: { from: '/missing' },
        b: { from: '/nothing' },
        c: { from: '/name', transform: { kind: 'trim' } },
      },
      record,
    );
    expect(out).toEqual({ c: 'Alex' });
  });

  it('maps enums with a default and omits unmapped values without one', () => {
    const map = { G: 'Gold', S: 'Silver' };
    expect(
      applyMapping(
        { tier: { from: '/tier', transform: { kind: 'enum', options: { map } } } },
        record,
      ),
    ).toEqual({ tier: 'Gold' });
    expect(
      applyMapping(
        {
          tier: {
            from: '/tier',
            transform: { kind: 'enum', options: { map: { S: 'x' }, default: 'Basic' } },
          },
        },
        record,
      ),
    ).toEqual({ tier: 'Basic' });
    expect(
      applyMapping(
        { tier: { from: '/tier', transform: { kind: 'enum', options: { map: { S: 'x' } } } } },
        record,
      ),
    ).toEqual({});
  });

  it('does not resolve enum keys through the prototype', () => {
    const out = applyMapping(
      { v: { from: '/k', transform: { kind: 'enum', options: { map: {} } } } },
      { k: 'constructor' },
    );
    expect(out).toEqual({});
  });

  it('converts booleans to a status', () => {
    const t = (options?: Record<string, string>) => ({
      s: { from: '/active', transform: { kind: 'bool-status', options } },
    });
    expect(applyMapping(t(), record)).toEqual({ s: 'active' });
    expect(applyMapping(t(), { active: false })).toEqual({ s: 'inactive' });
    expect(applyMapping(t({ true: 'Member', false: 'Lapsed' }), { active: 'no' })).toEqual({
      s: 'Lapsed',
    });
    expect(applyMapping(t(), { active: 'yes' })).toEqual({ s: 'active' });
  });

  it('formats dates from ISO strings and epochs', () => {
    const date = (from: string, options?: Record<string, string>) =>
      applyMapping({ d: { from, transform: { kind: 'date', options } } }, record).d;
    expect(date('/joined', { output: 'date' })).toBe('2024-03-05');
    expect(date('/joined')).toBe('2024-03-05T10:20:30.000Z');
    expect(date('/epoch', { output: 'date' })).toBe('2023-11-14');
    expect(date('/epoch', { output: 'epoch-ms' })).toBe(1_700_000_000_000);
    expect(date('/name')).toBeUndefined();
  });

  it('adds constants without a source and applies case transforms', () => {
    const out = applyMapping(
      {
        org: { from: '', transform: { kind: 'constant', options: { value: 'Henry' } } },
        up: { from: '/tier', transform: { kind: 'upper' } },
        low: { from: '/nested/code', transform: { kind: 'upper' } },
      },
      record,
    );
    expect(out).toEqual({ org: 'Henry', up: 'G', low: 'ABC' });
  });

  it('never writes reserved keys', () => {
    const out = applyMapping(JSON.parse('{"__proto__":{"from":"/tier"}}'), record);
    expect(Object.keys(out)).toEqual([]);
    expect(({} as Record<string, unknown>).tier).toBeUndefined();
  });
});

describe('validateMapping', () => {
  it('accepts a valid mapping and null', () => {
    expect(() => validateMapping(null)).not.toThrow();
    expect(() =>
      validateMapping({
        tier: { from: '/tier', transform: { kind: 'enum', options: { map: { a: 'b' } } } },
        c: { from: '', transform: { kind: 'constant', options: { value: 1 } } },
      }),
    ).not.toThrow();
  });

  it.each([
    ['bad field name', { 'a b': { from: '/x' } }],
    ['reserved field', JSON.parse('{"__proto__": {"from": "/x"}}')],
    ['bad pointer', { a: { from: '/x~2' } }],
    ['unknown transform', { a: { from: '/x', transform: { kind: 'eval' } } }],
    ['enum without map', { a: { from: '/x', transform: { kind: 'enum' } } }],
    ['constant without value', { a: { from: '', transform: { kind: 'constant' } } }],
    [
      'bad date output',
      { a: { from: '/x', transform: { kind: 'date', options: { output: 'x' } } } },
    ],
  ])('rejects %s', (_name, mapping) => {
    expect(() => validateMapping(mapping as never)).toThrow(ValidationError);
  });
});
