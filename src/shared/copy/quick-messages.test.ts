import { describe, expect, it } from 'vitest';
import { BROADCAST_MESSAGE_MAX } from '../contracts/broadcasts.ts';
import { QUICK_MESSAGES } from './quick-messages.ts';

describe('quick messages', () => {
  it('offers at least six with unique ids, labels and text', () => {
    expect(QUICK_MESSAGES.length).toBeGreaterThanOrEqual(6);
    for (const key of ['id', 'label', 'text'] as const)
      expect(new Set(QUICK_MESSAGES.map((q) => q[key])).size).toBe(QUICK_MESSAGES.length);
  });

  it('fit a message and carry no private detail', () => {
    for (const q of QUICK_MESSAGES) {
      expect(q.text.length).toBeLessThanOrEqual(BROADCAST_MESSAGE_MAX);
      expect(q.text).not.toMatch(/[{}@]|https?:/);
    }
  });
});
