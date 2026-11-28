import { describe, expect, it } from 'vitest';
import { isExpectedUnpaired } from './capture.ts';

describe('isExpectedUnpaired', () => {
  const session = 'http://localhost:5493/api/v1/scan/session';
  it('accepts 401 and 422 on the scan session read', () => {
    expect(isExpectedUnpaired(session, 401)).toBe(true);
    expect(isExpectedUnpaired(session, 422)).toBe(true);
  });
  it('keeps every other failure', () => {
    expect(isExpectedUnpaired(session, 500)).toBe(false);
    expect(isExpectedUnpaired('http://localhost:5493/api/v1/scan/actions', 401)).toBe(false);
  });
});
