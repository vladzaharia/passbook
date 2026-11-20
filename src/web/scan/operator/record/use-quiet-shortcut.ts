import { useCallback, useEffect, useRef } from 'react';
import { WEDGE_STANDARD } from '../../input/wedge-detector.ts';
import { type GateClock, realClock } from '../keys-gate.ts';

/** A letter shortcut acts this long after its key, with nothing else typed in between. */
export const QUIET_MS = 250;

/**
 * O, P (and N) change a pass, so they wait: 250 ms after the key, the key gate's own gap counting
 * toward it. Any other key before then means the letter belonged to a word or a reader's code:
 * the shortcut is cancelled and the letter goes to search as typing. Runs ahead of the gate's own
 * listener, so the letter is back in the field before the next key is read.
 */
export function useQuietShortcut(type: (text: string) => void, clock: GateClock = realClock) {
  const off = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => {
    off.current?.();
    off.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  return useCallback(
    (letter: string, act: () => void) => {
      cancel();
      const onKey = () => {
        cancel();
        type(letter);
      };
      const handle = clock.setTimeout(
        () => {
          cancel();
          act();
        },
        Math.max(0, QUIET_MS - WEDGE_STANDARD.maxGapMs),
      );
      window.addEventListener('keydown', onKey, true);
      off.current = () => {
        clock.clearTimeout(handle);
        window.removeEventListener('keydown', onKey, true);
      };
    },
    [cancel, clock, type],
  );
}
