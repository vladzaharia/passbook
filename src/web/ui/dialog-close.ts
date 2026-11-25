import { useCallback, useEffect, useRef } from 'react';

/**
 * Runs `onClose` once each time `open` goes from true to false, however the dialog closed (Cancel,
 * the X, Esc, a Done button or the parent setting the state), but only after the exit animation:
 * pass the returned function to the content's `onCloseAutoFocus`, so a draft does not blank while
 * the dialog fades. A content swap while still open (a result) does not fire it.
 */
export function useOnClose(open: boolean, onClose: (() => void) | undefined) {
  const latest = useRef(onClose);
  latest.current = onClose;
  const was = useRef(open);
  const pending = useRef(false);
  useEffect(() => {
    if (was.current && !open) pending.current = true;
    if (open) pending.current = false;
    was.current = open;
  }, [open]);
  return useCallback(() => {
    if (!pending.current) return;
    pending.current = false;
    latest.current?.();
  }, []);
}
