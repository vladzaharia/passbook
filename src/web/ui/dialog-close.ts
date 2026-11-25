import { useEffect, useRef } from 'react';

/**
 * Runs `onClose` each time `open` goes from true to false, however the dialog closed: Cancel, the
 * X, Esc, a Done button or the parent setting the state.
 */
export function useOnClose(open: boolean, onClose: (() => void) | undefined) {
  const latest = useRef(onClose);
  latest.current = onClose;
  const was = useRef(open);
  useEffect(() => {
    if (was.current && !open) latest.current?.();
    was.current = open;
  }, [open]);
}
