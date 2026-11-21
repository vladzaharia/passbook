import { describe, expect, it } from 'vitest';
import { keyChecks } from './repo-grant-checks.ts';

const sqlOf = (checks: ReturnType<typeof keyChecks>) =>
  checks.map((c) => c.ok({ bind: () => '?' } as never, undefined as never));

describe('keyChecks', () => {
  it('pins a key write to Test, or to Live for a review request', () => {
    expect(sqlOf(keyChecks('api_key'))).toEqual(["a.mode = 'test'"]);
    expect(sqlOf(keyChecks('api_key', true))).toEqual(["a.mode = 'live'"]);
    expect(keyChecks('session', true)).toEqual([]);
  });
});
