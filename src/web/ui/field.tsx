import { type ReactNode, useId } from 'react';
import { cn } from '../lib/cn.ts';
import { Label } from './label.tsx';

export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  'aria-required': true | undefined;
}

export interface FormFieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: string | undefined;
  required?: boolean;
  className?: string;
  /** Receives the id and aria props to spread on the control. */
  children: (control: FieldControlProps) => ReactNode;
}

export function FormField({ label, help, error, required, className, children }: FormFieldProps) {
  const id = useId();
  // The error replaces the help; the control points at whichever shows.
  const errorId = error ? `${id}-error` : undefined;
  const helpId = help && !error ? `${id}-help` : undefined;
  const describedBy = errorId ?? helpId;
  return (
    <div className={cn('flex flex-col', className)}>
      <Label htmlFor={id} className="mb-2">
        {label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-danger">
            *
          </span>
        ) : null}
      </Label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
      })}
      {error ? (
        <p id={errorId} className="mt-1 max-w-[65ch] text-xs text-danger">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="mt-1 max-w-[65ch] text-xs text-fg-muted">
          {help}
        </p>
      ) : null}
    </div>
  );
}
