import { describe, expect, it } from 'vitest';
import { isPrimary, nextAction } from './next-action.ts';

describe('nextAction', () => {
  it.each([
    ['design', 'design', 'Design'],
    ['try', 'try', 'Try on my phone'],
    ['release', 'release', 'Release v2'],
    ['request_review', 'request', 'Request review'],
    ['review', 'review', 'Review v2'],
    ['wait', 'wait', 'In review'],
    [null, 'pass', 'New pass'],
    [undefined, 'pass', 'New pass'],
  ] as const)('%s is %s', (next, kind, label) => {
    expect(nextAction(next, 'v2')).toEqual({ kind, label });
  });

  it('keeps New pass out of the release primaries', () => {
    expect(isPrimary(nextAction(null, ''))).toBe(false);
    expect(isPrimary(nextAction('release', 'v1'))).toBe(true);
  });
});
