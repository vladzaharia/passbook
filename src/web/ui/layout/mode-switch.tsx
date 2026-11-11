import { FlaskConical } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../../lib/cn.ts';
import { setMode, useMode } from '../../lib/mode.ts';
import { Switch } from '../switch.tsx';
import { Tooltip } from '../tooltip.tsx';

/** The current viewing mode and the Test mode switch in the top bar. */
export function ModeSwitch() {
  const mode = useMode();
  const on = mode === 'test';
  const label = useId();
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-md text-sm font-medium wl-colors sm:gap-2',
        on ? 'text-warning' : 'text-fg-muted',
      )}
    >
      <FlaskConical aria-hidden className="hidden size-4 shrink-0 sm:block" />
      {/* The visible words are the switch's name; the band and the state say which mode is on. */}
      <span id={label} className="whitespace-nowrap max-sm:sr-only">
        Test mode
      </span>
      <Tooltip content={on ? 'Leave Test mode' : 'Try things without sending email'}>
        <Switch
          checked={on}
          onCheckedChange={(next) => setMode(next ? 'test' : 'live')}
          aria-labelledby={label}
          className="data-[state=checked]:border-warning-border data-[state=checked]:bg-warning"
        />
      </Tooltip>
    </div>
  );
}
