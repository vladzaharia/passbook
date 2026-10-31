import { zodResolver } from '@hookform/resolvers/zod';
import type { ReactNode } from 'react';
import {
  type Control,
  Controller,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
  type UseFormReturn,
  useForm,
} from 'react-hook-form';
import type { z } from 'zod';
import { isApiError } from '../lib/errors.ts';
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
