import { describe, expect, it } from 'vitest';
import { WEDGE_STANDARD, WedgeDetector } from '../input/wedge-detector.ts';
import { flushTest, type TestRead, testKey } from './test-pad.tsx';

const keyOf = (ch: string) => ({
  key: ch,
  code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`,
  shiftKey: false,
});
const ENTER = { key: 'Enter', code: 'Enter', shiftKey: false };

/** Types `text` with `gap` ms between keys, then Enter when `enter`; the last read. */
function type(d: WedgeDetector, text: string, gap: number, enter: boolean) {
  let t = 0;
  let read: TestRead | null = null;
  for (const ch of text) {
    t += gap;
    read = testKey(d, keyOf(ch), t) ?? read;
  }
  if (enter) read = testKey(d, ENTER, t + gap) ?? read;
  return { read, t };
}

describe('scanner test', () => {
  it('reads a fast burst ending in Enter, with its pace', () => {
    expect(type(new WedgeDetector(WEDGE_STANDARD), 'pass1234', 12, true).read).toEqual({
      code: 'pass1234',
      gap: 12,
    });
  });

  it('ignores a person typing', () => {
    expect(type(new WedgeDetector(WEDGE_STANDARD), 'pass', 300, true).read).toBeNull();
  });

  it('ends a code with no terminator after a quiet spell', () => {
    const d = new WedgeDetector(WEDGE_STANDARD);
    const { t } = type(d, 'ABCDEFGHIJ', 10, false);
    expect(flushTest(d, t + WEDGE_STANDARD.idleAcceptMs)).toEqual({ code: 'abcdefghij', gap: 10 });
  });
});
