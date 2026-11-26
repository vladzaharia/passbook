import { flushSync } from 'react-dom';
import { prefersReducedMotion } from '../../../../lib/motion.ts';

type Doc = Document & { startViewTransition?: (update: () => void) => unknown };

/** Runs an edit inside a same-document View Transition (the suggestion chip becomes the source button). */
export function morph(update: () => void): void {
  const doc = document as Doc;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}
