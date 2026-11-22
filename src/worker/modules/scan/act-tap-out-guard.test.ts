import { describe, expect, it } from 'vitest';
import { assertTapOut, StaleScanAuthority } from './act-override.ts';
import type { Found } from './resolve.ts';

const found = (inactive?: 'voided' | 'expired') => ({ inactive }) as Found;

// OC4: unreachable through the API (evaluate refuses a non-exit first), so pin it here.
describe('assertTapOut', () => {
  it.each(['voided', 'expired'] as const)('refuses an entry on a %s pass', (state) => {
    expect(() => assertTapOut(found(state), 'in')).toThrow(StaleScanAuthority);
    expect(() => assertTapOut(found(state), 'used')).toThrow(StaleScanAuthority);
  });
  it('allows a tap-out of an inactive pass and any state of a live one', () => {
    expect(() => assertTapOut(found('voided'), 'out')).not.toThrow();
    expect(() => assertTapOut(found(), 'in')).not.toThrow();
  });
});
