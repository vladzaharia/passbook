import { describe, expect, it } from 'vitest';
import { personName } from './group-members.ts';

const who = (
  holder: string | null,
  type: string | null = 'Family pack',
  plan: string | null = null,
) => ({
  holder,
  type,
  plan,
});

describe('a bundle member as a person', () => {
  it('takes the holder name the read gave', () => {
    expect(personName(who('Ana Park'))).toBe('Ana Park');
  });
  it('never takes a title that stands for the pass', () => {
    expect(personName(who('Family pack'))).toBeNull();
    expect(personName(who('family PACK'))).toBeNull();
    expect(personName(who('Gold', 'Pass', 'Gold'))).toBeNull();
    expect(personName(who('Pass'))).toBeNull();
    expect(personName(who('Card'))).toBeNull();
  });
  it('has no one for a pass this role cannot read', () => {
    expect(personName(who(null))).toBeNull();
    expect(personName(undefined)).toBeNull();
  });
});
