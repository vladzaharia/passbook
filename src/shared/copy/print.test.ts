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

  it('says why passes were skipped', () => {
    expect(PRINT_COPY.bulkPreparing('1 ticket', 4, 'Paper is off for Day pass')).toBe(
      'Preparing 1 ticket. 4 skipped: Paper is off for Day pass.',
    );
    expect(PRINT_COPY.bulkReady('1 ticket', false, 4, 'Paper is off for Day pass')).toBe(
      '1 ticket ready, 4 skipped: Paper is off for Day pass',
    );
  });
});
