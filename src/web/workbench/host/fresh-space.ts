import { useLayoutEffect } from 'react';
import { resetSessionGone } from './session-gone.ts';
import { forgetTokens } from './token.ts';

/**
 * A space for a new person starts with no token and no banner. It runs in the layout phase, which
 * finishes before any child's `useEffect`: in a passive effect the parent's reset ran after a
 * tool's first read had begun its mint, and the reset then failed that read for good.
 */
export function useFreshSpace(): void {
  useLayoutEffect(() => {
    forgetTokens();
    resetSessionGone();
  }, []);
}
