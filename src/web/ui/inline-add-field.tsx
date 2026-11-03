import { Plus } from 'lucide-react';
import { type FormEvent, useId } from 'react';
import { cn } from '../lib/cn.ts';
import { Button } from './button.tsx';
import { useBlockedSubmit, useFormErrors } from './form.tsx';
import { Input } from './input.tsx';
import { Label } from './label.tsx';

export interface InlineAddFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Runs with the trimmed value once `validate` passes. */
  onSubmit: (value: string) => void;
  /**
   * The message for a value that cannot be added (the empty value included), else undefined.
   * Without it an empty value reads "Required.".
   */
  validate?: (value: string) => string | undefined;
  buttonLabel?: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'url';
  autoComplete?: string;
  help?: string;
  /** From the server, one sentence; a validation message wins over it. */
  error?: string;
  busy?: boolean;
  className?: string;
}

const required = (v: string) => (v ? undefined : 'Required.');

/**
 * Label above; input and button share one row at the same height; help or error sit under the
 * input only, so the button never moves. A refused add shows the error, focuses the field and
 * announces it once (form.tsx); the error clears as soon as the value is valid.
 */
export function InlineAddField({
  label,
  value,
  onChange,
  onSubmit,
  validate = required,
  buttonLabel = 'Add',
  placeholder,
  type = 'text',
  autoComplete,
  help,
  error,
  busy,
  className,
}: InlineAddFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const v = value.trim();
  const check = useFormErrors({ value: validate(v) });
  const blocked = useBlockedSubmit<HTMLFormElement>();
  const shown = check.errors.value ?? error;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (check.form.invalid) {
      check.form.onInvalid();
      blocked.block();
      return;
    }
    check.reset();
    onSubmit(v);
  };
  return (
    <form
      ref={blocked.ref}
      noValidate
      onSubmit={submit}
      className={cn('flex flex-col gap-2', className)}
    >
      <Label htmlFor={id}>{label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1">
        <Input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-invalid={shown ? true : undefined}
          aria-describedby={help || shown ? noteId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          loading={busy}
          iconStart={<Plus aria-hidden />}
          className="pointer-coarse:min-h-11"
        >
          {buttonLabel}
        </Button>
        {shown || help ? (
          <p
            id={noteId}
            className={cn('col-start-1 text-xs', shown ? 'text-danger' : 'text-fg-muted')}
          >
            {shown ?? help}
          </p>
        ) : null}
      </div>
      {blocked.live}
    </form>
  );
}
