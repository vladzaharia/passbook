import { describe, expect, it } from 'vitest';
import type { QueueRow } from './queue-store.ts';
import { queueView } from './queue-view.ts';

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  key: 'k1',
  scannerId: 's1',
  code: 'ABCDEFGHIJKLMNOPQRSTUVWX2F',
  method: 'camera',
  clientTs: 100,
  door: 'listed',
  ...over,
});

describe('the queue as the shift sheet reads it', () => {
  it('keeps when, how and the door call, and only the end of the code', () => {
    const [v] = queueView([row()]);
    expect(v).toEqual({ key: 'k1', at: 100, method: 'camera', door: 'listed', tail: 'WX2F' });
    expect(JSON.stringify(v)).not.toContain('ABCDEFGH');
  });
  it('keeps the order it was given', () => {
    expect(queueView([row({ key: 'a' }), row({ key: 'b' })]).map((r) => r.key)).toEqual(['a', 'b']);
  });
});
