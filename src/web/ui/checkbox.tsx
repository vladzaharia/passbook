import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId } from 'react';
import { cn } from '../lib/cn.ts';
import { Label } from './label.tsx';

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-surface-sunken text-state-checked-on',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        'data-[state=checked]:border-state-checked-edge data-[state=checked]:bg-state-checked-fill',
        'data-[state=indeterminate]:border-state-checked-edge data-[state=indeterminate]:bg-state-checked-fill',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        {props.checked === 'indeterminate' ? (
          <Minus aria-hidden className="size-3.5" />
        ) : (
          <Check aria-hidden className="size-3.5" />
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
    <div className={cn('flex min-h-6 items-center gap-2', className)}>
      <Checkbox id={id} {...props} />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}
