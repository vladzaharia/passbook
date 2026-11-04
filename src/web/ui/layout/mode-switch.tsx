import { FlaskConical } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { setMode, useMode } from '../../lib/mode.ts';
import { Switch } from '../switch.tsx';
import { Tooltip } from '../tooltip.tsx';

/**
 * The Test mode switch in the top bar: the shared Switch, amber while on. The word shows from sm;
 * on a phone the flask stands for it.
 */
export function ModeSwitch() {
  const mode = useMode();
  const on = mode === 'test';
  return (
    <Tooltip content={on ? 'Leave Test mode' : 'Try things without sending email'}>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 rounded-md text-sm font-medium wl-colors',
          on ? 'text-warning' : 'text-fg-muted',
        )}
      >
        <FlaskConical aria-hidden className="size-4 shrink-0" />
        <span aria-hidden className="hidden sm:inline">
          Test mode
        </span>
        <Switch
          checked={on}
          onCheckedChange={(next) => setMode(next ? 'test' : 'live')}
          aria-label="Test mode"
          className="data-[state=checked]:border-warning-border data-[state=checked]:bg-warning"
        />
      </div>
    </Tooltip>
  );
}
