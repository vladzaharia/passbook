import { describe, expect, it } from 'vitest';
import { passHeading } from './heading.ts';

describe('passHeading', () => {
  it('splits `{Org} {kind}` at the org, curly quotes or straight', () => {
    expect(passHeading('Henry’s Gymnasium membership', ['Henry’s Gymnasium'], 'Maya Chen')).toEqual(
      {
        title: 'Henry’s Gymnasium membership',
        org: 'Henry’s Gymnasium',
        kind: 'Membership',
      },
    );
    expect(passHeading("Henry's Gym membership card", ['Henry’s Gym'], 'x').kind).toBe(
      'Membership card',
    );
  });

  it('tries each name for the org: the pass’s, then the record’s', () => {
    const h = passHeading('Northwind Climbing coupon', ['Organization', 'Northwind Climbing'], 'x');
    expect(h).toEqual({
      title: 'Northwind Climbing coupon',
      org: 'Northwind Climbing',
      kind: 'Coupon',
    });
  });

  it('puts the org in front of a description without it', () => {
    expect(passHeading('Membership card', ['Northwind'], 'x')).toEqual({
      title: 'Northwind membership card',
      org: 'Northwind',
      kind: 'Membership card',
    });
    // An acronym keeps its capitals.
    expect(passHeading('VIP pass', ['Harbor'], 'x').title).toBe('Harbor VIP pass');
  });

  it('falls back to the pass title without a description, and drops an empty kind', () => {
    expect(passHeading('  ', ['Gym'], 'Sam Smith')).toEqual({
      title: 'Sam Smith',
      org: 'Gym',
      kind: null,
    });
    expect(passHeading('Gym', ['Gym'], 'x')).toEqual({ title: 'Gym', org: 'Gym', kind: null });
    expect(passHeading('event ticket', [''], 'x')).toEqual({
      title: 'Event ticket',
      org: '',
      kind: 'Event ticket',
    });
  });
});
