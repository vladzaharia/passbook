import { describe, expect, it } from 'vitest';
import { afterCommit } from './after-commit.ts';
import type { DisplayHistoryPlan } from './scan-display-history.ts';

describe('afterCommit', () => {
  it('is made only from a committed grant result', () => {
    expect(() => afterCommit({ writes: [] })).toThrow('No committed grant');
    expect(afterCommit({ writes: [{}] })).toMatchObject({ sql: '1', params: [] });
  });

  it('is the only thing a post-commit bind accepts: a plain open predicate does not compile', () => {
    const plan = {} as DisplayHistoryPlan;
    const never = () => {
      // @ts-expect-error a raw '1' is not the marker of a committed grant
      plan.bindAfterCommit(0, { sql: '1', params: [] });
      plan.bindAfterCommit(0, afterCommit({ writes: [{}] }));
    };
    expect(never).toBeTypeOf('function');
  });
});
