import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Minus } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
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
        // The button is the 44 px touch target; the 20 px box is drawn inside it.
        'group/cb relative inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-state-checked-on pointer-coarse:size-11',
        'focus-visible:outline-none disabled:cursor-not-allowed',
        className,
      )}
      onCheckedChange={(value) => {
        setChanged((n) => n + 1);
        onCheckedChange?.(value);
      }}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-1/2 left-1/2 size-5 -translate-1/2 rounded-sm border border-border-strong bg-surface-raised wl-colors',
          'group-hover/cb:not-group-disabled/cb:border-fg-muted',
          'group-focus-visible/cb:outline-2 group-focus-visible/cb:outline-offset-2 group-focus-visible/cb:outline-focus',
          'group-data-[state=checked]/cb:border-state-checked-edge group-data-[state=checked]/cb:bg-state-checked-fill',
          'group-data-[state=indeterminate]/cb:border-state-checked-edge group-data-[state=indeterminate]/cb:bg-state-checked-fill',
          'group-disabled/cb:bg-surface-sunken group-disabled/cb:opacity-50',
        )}
      />
      <CheckboxPrimitive.Indicator className="relative flex group-disabled/cb:opacity-50">
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
      <Checkbox id={id} className="pointer-coarse:-mx-3" {...props} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}
