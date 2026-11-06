import { describe, expect, it } from 'vitest';
import { fixtureState } from './fixtures.test-support.ts';
import { answerOf, at, readOf, requestKey, step } from './reduce.test-support.ts';

describe('a reader result while a sheet is open', () => {
  it.each(['lookup', 'recent', 'settings', 'shift'] as const)(
    'closes the %s sheet for the verdict',
    (overlay) => {
      const checking = step(fixtureState({ overlay }), readOf('OVERLAY-PASS'));
      const result = step(checking.state, answerOf(requestKey(checking.cmds)), at(100));
      expect(result.state.loop.s).toBe('verdict');
      expect(result.state.overlay).toBeNull();
    },
  );
});
