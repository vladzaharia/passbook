import { FlaskConical } from 'lucide-react';
import { useMode } from '../../lib/mode.ts';
import './mode.css';

/** Amber, persistent, and out of the layout flow (AppShell hangs it under the bar). */
export function ModeBand() {
  const mode = useMode();
  if (mode !== 'test') return null;
  return (
    <div
      role="status"
      className="wl-mode-band flex h-5 items-center justify-center gap-1.5 border-b border-warning-border bg-warning-subtle px-safe text-xs font-medium text-warning"
    >
      <FlaskConical aria-hidden className="size-3" />
      Test mode
      <span className="hidden font-normal sm:inline">· Emails go to the Test inbox.</span>
    </div>
  );
}
