import { describe, expect, it } from 'vitest';
import { PRINT_COPY } from './print.ts';

describe('bulk ready line', () => {
  it('counts every skipped pass and says when names were replaced', () => {
    expect(PRINT_COPY.bulkReady('3 tickets', false, 0)).toBe('3 tickets ready');
    expect(PRINT_COPY.bulkReady('3 tickets', false, 2)).toBe('3 tickets ready, 2 skipped');
    expect(PRINT_COPY.bulkReady('3 tickets', true, 1)).toBe(
      '3 tickets ready, 1 skipped. Some names could not be shown.',
    );
  });
});
