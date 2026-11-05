import { describe, expect, it } from 'vitest';
import {
  archiveConfirm,
  cancelBroadcastConfirm,
  clearHolderConfirm,
  deleteConfirm,
  goLiveConfirm,
  pairAgainConfirm,
  removeEmailConfirm,
  revokeKeyConfirm,
  revokeScannerConfirm,
  revokeSessionsConfirm,
  voidConfirm,
} from './confirms.ts';

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

  it('words void, clear holder and archive the same wherever they are asked', () => {
    expect(voidConfirm()).toMatchObject({
      title: 'Void pass?',
      confirmLabel: 'Void',
      typed: false,
    });
    expect(voidConfirm(3).title).toBe('Void 3 passes?');
    expect(voidConfirm(3).description).toMatch(/them as void on every holder's device/);
    expect(clearHolderConfirm('maya@example.com').description).toBe(
      'maya@example.com loses the pass in their account.',
    );
    expect(clearHolderConfirm(null).description).toBe('The pass goes back to having no holder.');
    expect(archiveConfirm('Member', 1)).toEqual({
      title: 'Archive Member?',
      confirmLabel: 'Archive',
      description: 'New passes cannot use it. 1 existing pass keeps working.',
      typed: false,
    });
    expect(archiveConfirm('Member', 4).description).toMatch(/4 existing passes keep working/);
    expect(archiveConfirm('Member', 0).description).toBe('New passes cannot use it.');
  });

  it('words cancelling a message, a change and a draft apart, and never dismisses with Cancel', () => {
    const msg = cancelBroadcastConfirm('Sale', 'message', 'scheduled');
    expect(msg.confirmLabel).toBe('Cancel message');
    expect(cancelBroadcastConfirm('Sale', 'change', 'scheduled').confirmLabel).toBe(
      'Cancel change',
    );
    // The service moves a draft to 'cancelled' (it is not deleted), so the copy must not say delete.
    const draft = cancelBroadcastConfirm('Sale', 'message', 'draft');
    expect(draft).toMatchObject({ title: 'Cancel Sale?', confirmLabel: 'Cancel message' });
    expect(draft.description).toBe('It moves to Cancelled. No pass changes.');
    expect(JSON.stringify(draft)).not.toMatch(/delete|undone/i);
    expect(msg.cancelLabel).toBe('Keep it');
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

  it('signs someone else out everywhere with a plain confirm', () => {
    expect(revokeSessionsConfirm('Maya')).toEqual({
      title: 'Sign Maya out everywhere?',
      confirmLabel: 'Revoke all',
      description: 'Every session ends. They can sign in again.',
      typed: false,
    });
  });
});

describe('scanner confirm copy', () => {
  it('revokes in one click and says the scans stay', () => {
    expect(revokeScannerConfirm('Front door')).toEqual({
      title: 'Revoke Front door?',
      confirmLabel: 'Revoke',
      description: 'The device stops scanning at once. Its scans stay. This cannot be undone.',
      typed: false,
    });
  });

  it('pairs again without calling it dangerous', () => {
    expect(pairAgainConfirm('Front door')).toEqual({
      title: 'Pair Front door again?',
      confirmLabel: 'Pair again',
      description: 'The device using it now signs out at its next scan.',
      typed: false,
    });
  });

  it('goes live with what changes for passes', () => {
    expect(goLiveConfirm('Front door')).toEqual({
      title: 'Make Front door live?',
      confirmLabel: 'Go live',
      description:
        'It starts accepting live passes and stops accepting test ones. Its test scans stay in Test mode.',
      typed: false,
    });
  });
});
