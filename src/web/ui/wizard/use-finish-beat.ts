import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../../lib/motion.ts';
import type { ResultSpec } from './wizard-result.tsx';

/** How long the last marker shows its tick before the result takes the dialog. */
export const FINISH_BEAT_MS = 320;

/**
 * Holds a result back one beat so the finish reads: `holding` is true from the moment the result
 * arrives until `result` is handed on. Reduced motion skips the beat.
 */
export function useFinishBeat(result: ResultSpec | undefined) {
  const has = result !== undefined;
  const [ready, setReady] = useState(has);
  useEffect(() => {
    if (!has) {
      setReady(false);
      return;
    }
    if (ready) return;
    const t = setTimeout(() => setReady(true), FINISH_BEAT_MS);
    return () => clearTimeout(t);
  }, [has, ready]);
  const show = has && (ready || prefersReducedMotion());
  return { result: show ? result : undefined, holding: has && !show };
}
