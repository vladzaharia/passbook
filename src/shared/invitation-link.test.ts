import { describe, expect, it } from 'vitest';
import { inviteKindOf } from './invitation-link.ts';

const body = 'a'.repeat(43);

describe('inviteKindOf', () => {
  it('routes a prefixed secret by its prefix and a bare 43-character one to member invitations, whatever it starts with', () => {
    expect(inviteKindOf(`m_${body}`)).toBe('member');
    expect(inviteKindOf(`d_${body}`)).toBe('developer');
    expect(inviteKindOf(`p_${body}`)).toBe('platform');
    expect(inviteKindOf(body)).toBe('member');
    // A legacy secret whose own first letters look like a prefix.
    expect(inviteKindOf(`d_${'b'.repeat(41)}`)).toBe('member');
    expect(inviteKindOf(`p_${'b'.repeat(41)}`)).toBe('member');
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'short', `x_${body}`, `${body}!`, `m_${body}a`])
      expect(inviteKindOf(bad)).toBeNull();
  });
});
