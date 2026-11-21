import { flushSync } from 'react-dom';
import { prefersReducedMotion } from '../lib/motion.ts';

type TransitionDoc = Document & {
  startViewTransition?: (arg: (() => void) | { update: () => void; types: string[] }) => unknown;
};

const typed = () =>
  typeof CSS !== 'undefined' && CSS.supports('selector(:active-view-transition-type(a))');

/**
 * Brings a peek forward. With View Transitions (and motion allowed) the peek's strip morphs into
 * the front card and the old front folds into its strip (`stack` type: main stays put; the group
 * clips, pass-stack.css). Returns false when it updated at once, so the caller can raise the new
 * front instead (or nothing, under reduced motion).
 */
export function pickWithTransition(update: () => void): boolean {
  const doc = document as TransitionDoc;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return false;
  }
  const run = () => flushSync(update);
  doc.startViewTransition(typed() ? { update: run, types: ['stack'] } : run);
  return true;
}

/** The router's option for a stack navigation (master-detail): the same morph, no route slide. */
export function stackNavigation(): false | true | { types: string[] } {
  if (typeof document === 'undefined' || prefersReducedMotion()) return false;
  if (!('startViewTransition' in document)) return false;
  return typed() ? { types: ['stack'] } : true;
}
