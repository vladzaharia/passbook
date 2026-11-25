import { describe, expect, it } from 'vitest';
import { removeMemberConfirm } from './confirms-members.ts';

describe('member confirms', () => {
  it('asks to remove a member and says access ends at once', () => {
    expect(removeMemberConfirm('Ada', 'Acme')).toEqual({
      title: 'Remove Ada?',
      confirmLabel: 'Remove',
      description: 'They lose access to Acme at once.',
      typed: false,
    });
  });
});
