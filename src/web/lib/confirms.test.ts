import { describe, expect, it } from 'vitest';
import { deleteConfirm, removeEmailConfirm, revokeKeyConfirm } from './confirms.ts';

describe('confirm copy', () => {
  it('asks "Delete {name}?" and says it cannot be undone', () => {
    const org = deleteConfirm('org', 'Northwind');
    expect(org).toMatchObject({ title: 'Delete Northwind?', confirmLabel: 'Delete' });
    expect(org.description).toBe(
      'Its templates, passes and connections stop working. This cannot be undone.',
    );
  });

  it('asks for the typed name only when the act reaches past the item', () => {
    expect(deleteConfirm('org', 'a').typed).toBe(true);
    expect(deleteConfirm('pass', 'a').typed).toBe(true);
    expect(deleteConfirm('connection', 'a').typed).toBe(true);
    expect(deleteConfirm('template', 'a').typed).toBe(false);
    expect(deleteConfirm('identity', 'a').typed).toBe(false);
    expect(revokeKeyConfirm('CI').typed).toBe(false);
  });

  it('words removing an email for the holder and for an admin', () => {
    const mine = removeEmailConfirm('a@example.com', true);
    const theirs = removeEmailConfirm('a@example.com', false);
    expect(mine.title).toBe('Remove a@example.com?');
    expect(theirs.title).toBe(mine.title);
    expect(mine.description).toMatch(/^You can no longer sign in with it/);
    expect(theirs.description).toMatch(/^They can no longer sign in with it/);
    expect(mine.confirmLabel).toBe('Remove');
  });

  it('revokes a key with the same shape', () => {
    expect(revokeKeyConfirm('CI')).toEqual({
      title: 'Revoke CI?',
      confirmLabel: 'Revoke',
      description: 'Requests using this key fail at once. This cannot be undone.',
      typed: false,
    });
  });
});
