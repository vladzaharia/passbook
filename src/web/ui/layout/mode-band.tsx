import { useMode } from '../../lib/mode.ts';
import './mode.css';
import './test-strip.css';
import { TestStrip } from './test-strip.tsx';

/** Amber, persistent, in flow under the top bar (AppShell). Mode is read at load: no shift on open. */
export function ModeBand() {
  const mode = useMode();
  if (mode !== 'test') return null;
  return (
    <TestStrip className="wl-mode-band" more="· New emails go to the Test inbox.">
      Test mode
    </TestStrip>
  );
}
