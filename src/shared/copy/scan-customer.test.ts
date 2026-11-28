import { describe, expect, it } from 'vitest';
import { ScanReasonSchema } from '../contracts/scan.ts';
import { SCAN_REASON_COPY } from './scan.ts';
import { CUSTOMER_COPY, CUSTOMER_REASON_SUB } from './scan-customer.ts';

const CLIENT_ONLY = [
  'network',
  'timeout',
  'unconfirmed',
  'still_unconfirmed',
  'server',
  'rate_limited',
  'saved_offline',
  'add_link',
];

describe('every reason has scanner and customer copy', () => {
  it.each(ScanReasonSchema.options)('%s', (reason) => {
    expect(SCAN_REASON_COPY[reason].headline.length).toBeGreaterThan(0);
    expect(reason in CUSTOMER_REASON_SUB).toBe(true);
  });

  it('the customer map has no reason the wire lacks', () => {
    expect(Object.keys(CUSTOMER_REASON_SUB).sort()).toEqual([...ScanReasonSchema.options].sort());
    for (const reason of CLIENT_ONLY) expect(reason in CUSTOMER_REASON_SUB).toBe(false);
  });

  it('a customer is told only what they can act on', () => {
    const withSub = Object.entries(CUSTOMER_REASON_SUB).filter(([, sub]) => sub !== null);
    expect(withSub.map(([reason]) => reason).sort()).toEqual([
      'capacity_full',
      'guest_expired',
      'guest_visits_used',
      'outside_hours',
      'still_inside',
    ]);
    for (const [, sub] of withSub) {
      expect(sub).not.toMatch(/zone|plan's|suspend|staff|manager|override|count/i);
      for (const [, key] of (sub ?? '').matchAll(/\{(\w+)\}/g)) expect(key).toBe('when');
    }
  });

  it('every refusal is one line', () => {
    expect(CUSTOMER_COPY.refusedLine).toBe('Please see the desk');
    expect(CUSTOMER_COPY.welcome).toBe('Hold up your pass');
    expect(CUSTOMER_COPY.checkedOut).toBe('Checked out');
  });
});
