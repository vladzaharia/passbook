import { describe, expect, it } from 'vitest';
import { roleOfStoredSurface, storedSurfaceFor } from './scan-surfaces.ts';

describe('storedSurfaceFor', () => {
  it('keeps a Monitor a Monitor and a Customer screen a Customer screen', () => {
    expect(storedSurfaceFor('desk', null)).toBe('desk');
    expect(roleOfStoredSurface(storedSurfaceFor('desk', null))).toBe('monitor');
    expect(roleOfStoredSurface(storedSurfaceFor('customer', null))).toBe('customer');
    expect(storedSurfaceFor('operator', null)).toBe('operator');
  });
});
