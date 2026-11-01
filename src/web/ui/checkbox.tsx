import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { TOUCH_HIT } from './button.tsx';
import { Label } from './label.tsx';

export function Checkbox({
  className,
  onCheckedChange,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>) {
  // The tick pops only when the user changes it, never on load or a form reset.
  const [changed, setChanged] = useState(0);
  const Icon = props.checked === 'indeterminate' ? Minus : Check;
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
        <Icon key={changed} aria-hidden className={cn('size-3.5', changed > 0 && 'wl-tick')} />
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
