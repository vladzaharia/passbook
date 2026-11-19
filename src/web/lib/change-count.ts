import { useRef } from 'react';

/** Counts renders where `value` changed after mount: a key that replays a one-shot animation. */
export function useChangeCount(value: unknown): number {
  const prev = useRef(value);
  const count = useRef(0);
  if (!Object.is(prev.current, value)) {
    prev.current = value;
    count.current += 1;
  }
  return count.current;
}
