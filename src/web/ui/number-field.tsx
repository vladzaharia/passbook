import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from '../lib/cn.ts';
import { CONTROL, CONTROL_HEIGHT } from './input.tsx';

export interface NumberFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  value: number | null | undefined;
  onValueChange: (value: number | null) => void;
  /** Shown inside the field, after the number ("days", "%"). */
  unit?: string;
  ref?: Ref<HTMLInputElement>;
}

/** A number with its unit inside the field; no spin buttons. Fixed width (w-28) by default. */
export function NumberField({
  value,
  onValueChange,
  unit,
  className,
  ref,
  ...props
}: NumberFieldProps) {
  return (
    <div className={cn('relative w-28', className)}>
      <input
        ref={ref}
        type="number"
        inputMode="decimal"
        value={value ?? ''}
        onChange={(e) => onValueChange(e.target.value === '' ? null : Number(e.target.value))}
        className={cn(
          CONTROL,
          CONTROL_HEIGHT,
          'tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          unit && 'pr-12',
        )}
        {...props}
      />
      {unit ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-fg-muted"
        >
          {unit}
        </span>
      ) : null}
    </div>
  );
}
