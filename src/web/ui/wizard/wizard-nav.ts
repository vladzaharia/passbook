import { useState } from 'react';

/**
 * Where a wizard is and which way it last moved: the current index, the furthest step reached,
 * and the counter WizardStep animates from. `onMove` runs before every move.
 */
export function useWizardNav(
  steps: readonly { skip?: boolean | undefined }[],
  firstIndex: number,
  onMove: () => void,
) {
  const [index, setIndex] = useState(firstIndex);
  const [reached, setReached] = useState(0);
  const [motion, setMotion] = useState<{ key: number; direction: 1 | -1 }>({
    key: 0,
    direction: 1,
  });

  return {
    index,
    reached,
    motion,
    move(to: number) {
      if (!steps[to] || steps[to]?.skip) return;
      const direction = to >= index ? 1 : -1;
      setMotion((m) => ({ key: m.key + 1, direction }));
      onMove();
      setReached((r) => Math.max(r, to));
      setIndex(to);
    },
    /** The nearest step that is not skipped, or -1. */
    hop(from: number, step: 1 | -1) {
      let at = from + step;
      while (steps[at]?.skip) at += step;
      return steps[at] ? at : -1;
    },
    reset() {
      setIndex(firstIndex);
      setReached(0);
    },
  };
}
