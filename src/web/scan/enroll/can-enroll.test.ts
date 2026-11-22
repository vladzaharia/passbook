import { describe, expect, it } from 'vitest';
import { canReadEnrollments } from './can-enroll.ts';

const base = { device: true, reading: true, role: 'desk', assign: 'desk' };

describe('canReadEnrollments', () => {
  it('reads for a desk on a scanner that assigns tags', () => {
    expect(canReadEnrollments(base)).toBe(true);
    expect(canReadEnrollments({ ...base, role: 'manager', assign: 'manager' })).toBe(true);
  });
  it('does not ask as a door, which the route refuses with 403', () => {
    expect(canReadEnrollments({ ...base, role: 'door' })).toBe(false);
  });
  it('does not ask when assigning tags is off', () => {
    expect(canReadEnrollments({ ...base, assign: 'never' })).toBe(false);
  });
  it('does not ask off a device or without a tag reader', () => {
    expect(canReadEnrollments({ ...base, device: false })).toBe(false);
    expect(canReadEnrollments({ ...base, reading: false })).toBe(false);
  });
});
