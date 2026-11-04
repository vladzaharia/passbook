import * as SwitchPrimitive from '@radix-ui/react-switch';
import { FlaskConical } from 'lucide-react';
import { cn } from '../../lib/cn.ts';
import { setMode, useMode } from '../../lib/mode.ts';
import { TOUCH_HIT } from '../button.tsx';
import { Tooltip } from '../tooltip.tsx';

/**
 * The Test mode switch in the top bar. A switch, not a button: it holds a state. The label shows
 * from sm; on a phone the flask stands for it.
 */
export function ModeSwitch() {
  const mode = useMode();
  const on = mode === 'test';
  return (
    <Tooltip content={on ? 'Leave Test mode' : 'Try things without sending anything'}>
      <SwitchPrimitive.Root
        checked={on}
        onCheckedChange={(next) => setMode(next ? 'test' : 'live')}
        aria-label="Test mode"
        className={cn(
          'group relative inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium wl-colors',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          'pointer-coarse:min-h-11',
          on
            ? 'border-warning-border bg-warning-subtle text-warning'
            : 'border-border-strong bg-transparent text-fg-muted hover:bg-state-hover-tint hover:text-fg-strong',
          TOUCH_HIT,
        )}
      >
        <FlaskConical aria-hidden className="size-4 shrink-0" />
        <span className="hidden sm:inline">Test mode</span>
        <span
          aria-hidden
          className={cn(
            'hidden size-2 rounded-full sm:block',
            on ? 'bg-warning' : 'bg-border-strong',
          )}
        />
      </SwitchPrimitive.Root>
    </Tooltip>
  );
}
