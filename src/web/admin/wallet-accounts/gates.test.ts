import { describe, expect, it } from 'vitest';
import { blockerOf, gatesOf } from './gates.ts';
import { enrolment } from './wallet-accounts-test-fixtures.ts';

describe('enrolment gates', () => {
  it('names what blocks the switch, in the order to fix it', () => {
    expect(blockerOf(enrolment({ state: 'held', hold: { at: 1, reason: 'abuse' } }))).toBe(
      'Held by PassBook: abuse',
    );
    expect(blockerOf(enrolment({ state: 'revoked' }))).toBe('Revoked.');
    expect(blockerOf(enrolment({ state: 'off' }))).toBe('Pick a source first.');
    expect(blockerOf(enrolment({ state: 'off', source: 'org' }))).toBe(
      'The account check has not passed.',
    );
    expect(
      blockerOf(
        enrolment({
          mode: 'live',
          state: 'off',
          source: 'org',
          prerequisites: { check: true, roundTrip: false },
        }),
      ),
    ).toBe('Save a pass from Test mode first.');
    expect(
      blockerOf(
        enrolment({ state: 'off', source: 'org', prerequisites: { check: true, roundTrip: null } }),
      ),
    ).toBeNull();
  });

  it('lists the round trip only in Live', () => {
    expect(gatesOf(enrolment()).map((g) => g.label)).toEqual(['Enrolment check']);
    expect(
      gatesOf(enrolment({ prerequisites: { check: true, roundTrip: false } })).map((g) => g.state),
    ).toEqual(['Passed', 'Needed']);
  });
});

describe('check freshness', () => {
  const day = 24 * 60 * 60 * 1000;
  it('is one rule: the server answer wins, else 24 hours', async () => {
    const { checkFresh } = await import('./check.ts');
    expect(checkFresh(1000, 1000 + day)).toBe(true);
    expect(checkFresh(1000, 1001 + day)).toBe(false);
    expect(checkFresh(null, 0)).toBe(false);
    expect(checkFresh(1000, 1000, false)).toBe(false);
  });
});
