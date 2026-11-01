import { type ReactNode, useId } from 'react';
import { cn } from '../lib/cn.ts';

export interface RadioOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  legend: ReactNode;
  options: readonly RadioOption[];
  value: string | undefined;
  onValueChange: (value: string) => void;
  name?: string;
  orientation?: 'vertical' | 'horizontal';
  className?: string;
}

/** Native radios: arrow-key navigation and form semantics come from the browser. */
export function RadioGroup({
  legend,
  options,
  value,
  onValueChange,
  name,
  orientation = 'vertical',
  className,
}: RadioGroupProps) {
  const auto = useId();
  const group = name ?? auto;
  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="mb-1.5 text-sm font-medium text-fg-strong">{legend}</legend>
      <div
        className={cn('flex gap-2', orientation === 'vertical' ? 'flex-col' : 'flex-wrap gap-x-5')}
      >
        {options.map((o) => {
          const id = `${group}-${o.value}`;
          return (
            <div key={o.value} className="flex min-h-6 items-start gap-2 pointer-coarse:min-h-11">
              <input
                id={id}
                type="radio"
                name={group}
                value={o.value}
                checked={value === o.value}
                disabled={o.disabled}
                onChange={() => onValueChange(o.value)}
                className="mt-0.5 size-4 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              />
              <label
                htmlFor={id}
                className="text-sm text-fg pointer-coarse:flex-1 pointer-coarse:self-stretch"
              >
                {o.label}
                {o.hint ? <span className="block text-xs text-fg-muted">{o.hint}</span> : null}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
