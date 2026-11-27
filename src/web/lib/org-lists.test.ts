import { describe, expect, it } from 'vitest';
import { canUseAllScope, isSandbox, listableMemberships, readablePassOrgs } from './org-lists.ts';
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

describe('readablePassOrgs', () => {
  it('keeps listable, active organizations with passes:read', () => {
    const items = [
      membershipFixture('a'),
      membershipFixture('s', { testOnly: true }),
      membershipFixture('r', { revokedAt: 1 }),
      membershipFixture('n', { capabilities: ['org:read'] }),
    ];
    expect(readablePassOrgs(items).map((m) => m.orgId)).toEqual(['a']);
    expect(canUseAllScope(items)).toBe(false);
    expect(canUseAllScope([...items, membershipFixture('b')])).toBe(true);
  });
});
