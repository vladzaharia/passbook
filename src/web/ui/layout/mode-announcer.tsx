import { useEffect, useRef, useState } from 'react';
import { adoptedMode, useMode } from '../../lib/mode.ts';
import { TEST_NOTE } from './mode-copy.ts';

/** Says the new mode through a polite live region; silent on load, so only a change speaks. */
export function ModeAnnouncer() {
  const mode = useMode();
  const seen = useRef(mode);
  // A launch link's `?mode=test` is adopted once: that load says so; a plain load stays silent.
  const [said, setSaid] = useState(() =>
    adoptedMode === 'test' && mode === 'test' ? `Test mode on. ${TEST_NOTE}` : '',
  );
  useEffect(() => {
    if (seen.current === mode) return;
    seen.current = mode;
    setSaid(mode === 'test' ? `Test mode on. ${TEST_NOTE}` : 'Live mode on.');
  }, [mode]);
  return (
    <p role="status" className="sr-only">
      {said}
    </p>
  );
}
