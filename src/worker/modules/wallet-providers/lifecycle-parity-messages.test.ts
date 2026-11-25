// Architecture 6.1, "Message / broadcast": Google's send path is GM2's (sync-operation-google-messages.ts);
// this file only pins the row to it, and the Samsung column's outcome.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageKit } from './google-messages-test-fixtures.ts';

let restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  vi.unstubAllGlobals();
});

describe('6.1 message and broadcast', () => {
  it('Google: object write, then one TEXT_AND_NOTIFY message; a replay sends nothing', async () => {
    const t = await messageKit(restore);
    const mark = t.mock.requests.length;
    await t.edit('Notified Member');
    expect(t.calls(mark)).toEqual(['PATCH genericObject', 'POST genericObject/addMessage']);
    await t.drain();
    expect(t.addMessageCalls()).toHaveLength(1);
  });

  it('Google: the ledger the broadcast forecast reads counts the notification', async () => {
    const t = await messageKit(restore);
    await t.edit('Counted Member');
    expect(await t.ledger()).toMatchObject([{ state: 'notified' }]);
  });
});
