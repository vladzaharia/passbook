import { zodResolver } from '@hookform/resolvers/zod';
import { type FormHTMLAttributes, type ReactNode, useRef, useState } from 'react';
import {
  type Control,
  Controller,
  type ControllerRenderProps,
  type FieldErrors,
  type FieldPath,
  type FieldValues,
  type SubmitHandler,
  type UseFormReturn,
  useForm,
} from 'react-hook-form';
import type { z } from 'zod';
import { isApiError } from '../lib/errors.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { type FieldControlProps, FormField } from './field.tsx';

/** react-hook-form with a zod schema. Values are the schema input; submit receives the output. */
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues: z.input<S>,
): UseFormReturn<z.input<S>, unknown, z.output<S>> {
  return useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema as never),
    defaultValues: defaultValues as never,
    mode: 'onTouched',
  });
}

/** Copies problem `issues` onto fields. Returns true when at least one field matched. */
export function applyApiErrors<T extends FieldValues>(
  form: Pick<UseFormReturn<T>, 'setError' | 'getValues'>,
  error: unknown,
): boolean {
  if (!isApiError(error)) return false;
  let matched = false;
  const known = form.getValues();
  for (const [path, message] of Object.entries(error.fields)) {
    const root = path.split('.')[0] ?? path;
    if (root in known) {
      form.setError(path as FieldPath<T>, { type: 'server', message });
      matched = true;
    }
  }
  return matched;
}

export interface RhfFieldProps<T extends FieldValues, N extends FieldPath<T>> {
  control: Control<T>;
  name: N;
  label: ReactNode;
  help?: ReactNode;
  required?: boolean;
  className?: string;
  children: (field: ControllerRenderProps<T, N>, control: FieldControlProps) => ReactNode;
}

export function RhfField<T extends FieldValues, N extends FieldPath<T>>({
  control,
  name,
  label,
  help,
  required,
  className,
  children,
}: RhfFieldProps<T, N>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FormField
          label={label}
          help={help}
          required={required}
          className={className}
          error={fieldState.error?.message}
        >
          {(props) => children(field, props)}
        </FormField>
      )}
    />
  );
}

/** Leaf error count in a react-hook-form errors tree. */
export function countErrors(errors: FieldErrors | Record<string, unknown>): number {
  let n = 0;
  for (const value of Object.values(errors)) {
    if (!value || typeof value !== 'object') continue;
    if ('message' in value || 'type' in value) n += 1;
    else n += countErrors(value as Record<string, unknown>);
  }
  return n;
}

export const attentionText = (n: number) =>
  n === 1 ? '1 field needs attention' : `${n} fields need attention`;

/**
 * A blocked submit focuses and scrolls to the first invalid control and announces one polite
 * summary ("2 fields need attention"). Fields show their errors through aria-describedby.
 */
export function focusFirstInvalid(root: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const target = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  });
}

export interface FormProps<T extends FieldValues, O>
  extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'onInvalid'> {
  form: UseFormReturn<T, unknown, O>;
  onSubmit: SubmitHandler<O>;
  children: ReactNode;
}

/** <form> wired to react-hook-form with the blocked-submit behaviour (focus, scroll, summary). */
export function Form<T extends FieldValues, O>({
  form,
  onSubmit,
  children,
  ...props
}: FormProps<T, O>) {
  const ref = useRef<HTMLFormElement>(null);
  const [summary, setSummary] = useState('');
  return (
    <form
      ref={ref}
      noValidate
      onSubmit={form.handleSubmit(
        (values) => {
          setSummary('');
          return onSubmit(values);
        },
        (errors) => {
          // A changed string re-announces even when the count repeats.
          const text = attentionText(Math.max(1, countErrors(errors)));
          setSummary((prev) => (prev === text ? `${text}\u200b` : text));
          focusFirstInvalid(ref.current);
        },
      )}
      {...props}
    >
      {children}
      <p role="status" aria-live="polite" className="sr-only">
        {summary}
      </p>
    </form>
  );
}
