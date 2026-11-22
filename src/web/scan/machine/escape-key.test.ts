import { expect, it } from 'vitest';
import { escapeEvent } from './escape-key.ts';

it('Escape closes the PIN form first, then dismisses, and leaves an open overlay alone', () => {
  expect(escapeEvent(false, true)).toEqual({ type: 'assign.pin', open: false });
  expect(escapeEvent(false, false)).toEqual({ type: 'dismiss' });
  expect(escapeEvent(true, true)).toBeNull();
});
