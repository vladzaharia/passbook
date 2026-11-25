import { useEffect, useRef, useState } from 'react';
import { useMode } from '../../lib/mode.ts';
import { TEST_NOTE } from './mode-copy.ts';

/** Says the new mode through a polite live region; silent on load, so only a change speaks. */
export function ModeAnnouncer() {
  const mode = useMode();
  const seen = useRef(mode);
  const [said, setSaid] = useState('');
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
