import { describe, expect, it } from 'vitest';
import { kindLabel } from './labels.ts';

describe('kindLabel', () => {
  it('joins connector and mode', () => {
    expect(kindLabel('Demo', 'Poll')).toBe('Demo, poll');
  });

  it('does not repeat a mode the connector name already says', () => {
    expect(kindLabel('Webhook push', 'Webhook')).toBe('Webhook push');
  });
});
