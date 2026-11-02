import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Minus } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { TOUCH_HIT } from './button.tsx';
import { Label } from './label.tsx';

/**
 * A check in two strokes; with `draw` it draws itself, short stroke then long (kit-controls.css).
 * Checkboxes, stepper and checklist marks: only after a change, never on load.
 */
export function Tick({ draw, className }: { draw?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn(draw && 'wl-tick', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M5 12.5l4.5 4.5" />
      <path d="M9.5 17L19 7.5" />
    </svg>
  );
}

export function Checkbox({
  className,
  onCheckedChange,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  // The tick draws only when the user changes it, never on load or a form reset.
  const [changed, setChanged] = useState(0);
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'relative inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-surface-raised text-state-checked-on wl-colors',
        'hover:not-disabled:border-fg-muted',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'data-[state=checked]:border-state-checked-edge data-[state=checked]:bg-state-checked-fill',
        'data-[state=indeterminate]:border-state-checked-edge data-[state=indeterminate]:bg-state-checked-fill',
        'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-50',
        TOUCH_HIT,
        className,
      )}
      onCheckedChange={(value) => {
        setChanged((n) => n + 1);
        onCheckedChange?.(value);
      }}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        {props.checked === 'indeterminate' ? (
          <Minus aria-hidden className="size-3.5" />
        ) : (
          <Tick key={changed} draw={changed > 0} className="size-3.5" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function CheckboxField({
  label,
  className,
  ...props
}: { label: ReactNode } & ComponentProps<typeof CheckboxPrimitive.Root>) {
  const id = useId();
  return (
    <div className={cn('flex min-h-6 items-center gap-2 pointer-coarse:min-h-11', className)}>
      <Checkbox id={id} {...props} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}
