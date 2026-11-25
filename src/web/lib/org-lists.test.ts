import { describe, expect, it } from 'vitest';
import { isSandbox, listableMemberships } from './org-lists.ts';
import { membershipFixture } from './test-utils.tsx';

describe('listableMemberships', () => {
  it('drops developer sandboxes and keeps every other organization in order', () => {
    const items = [
      membershipFixture('a'),
      membershipFixture('s', { testOnly: true }),
      membershipFixture('p', { personal: true }),
    ];
    expect(items.map(isSandbox)).toEqual([false, true, false]);
    expect(listableMemberships(items).map((m) => m.orgId)).toEqual(['a', 'p']);
  });
});
