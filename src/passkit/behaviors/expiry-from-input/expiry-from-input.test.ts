import { describe, expect, it } from 'vitest';
import type { BehaviorContext, PassJson } from '../../types.ts';
import { type ExpiryFromInputConfig, expiryFromInput } from './index.ts';

const ctx: BehaviorContext = {
  now: new Date('2030-01-01T00:00:00Z'),
  identity: { passTypeIdentifier: 'p', teamIdentifier: 't' },
  lookups: {},
};
const run = (
  input: Record<string, string | undefined>,
  config: ExpiryFromInputConfig,
  base: Partial<PassJson> = {},
) => {
  const pass = { ...base } as PassJson;
  expiryFromInput.apply(pass, input as never, config, ctx);
  return pass;
};

describe('expiry-from-input', () => {
  it('sets the expiry from the input', () => {
    expect(run({ ends: '2031-01-01T10:00:00Z' }, { input: 'ends' }).expirationDate).toBe(
      '2031-01-01T10:00:00Z',
    );
  });

  it('applies the offset and normalizes zones', () => {
    const pass = run({ ends: '2031-01-01T10:00:00+01:00' }, { input: 'ends', offsetMinutes: 60 });
    expect(pass.expirationDate).toBe('2031-01-01T10:00:00Z');
  });

  it('removes a template default when the input is empty', () => {
    const pass = run({}, { input: 'ends' }, { expirationDate: '2099-01-01T00:00:00Z' });
    expect(pass.expirationDate).toBeUndefined();
  });

  it('falls back to a duration from build time', () => {
    expect(run({}, { input: 'ends', fallbackDays: 30 }).expirationDate).toBe(
      '2030-01-31T00:00:00Z',
    );
  });

  it('voids a pass that is already expired only when asked', () => {
    const past = { ends: '2029-01-01T00:00:00Z' };
    expect(run(past, { input: 'ends' }).voided).toBeUndefined();
    expect(run(past, { input: 'ends', voidWhenPast: true }).voided).toBe(true);
    expect(
      run({ ends: '2031-01-01T00:00:00Z' }, { input: 'ends', voidWhenPast: true }).voided,
    ).toBeUndefined();
  });

  it('throws on an invalid date', () => {
    expect(() => run({ ends: 'soon' }, { input: 'ends' })).toThrow(/not a date/);
  });
});
