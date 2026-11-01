import { Plus } from 'lucide-react';
import { type FormEvent, useId } from 'react';
import { cn } from '../lib/cn.ts';
import { Button } from './button.tsx';
import { Input } from './input.tsx';
import { Label } from './label.tsx';

export interface InlineAddFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  buttonLabel?: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'url';
  autoComplete?: string;
  help?: string;
  error?: string;
  busy?: boolean;
  className?: string;
}

/**
 * Label above; input and button share one row at the same height; help or error sit under the
 * input only, so the button never moves.
 */
export function InlineAddField({
  label,
  value,
  onChange,
  onSubmit,
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (v) onSubmit(v);
  };
  return (
    <form noValidate onSubmit={submit} className={cn('flex flex-col gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1">
        <Input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={help || error ? noteId : undefined}
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
        {error || help ? (
          <p
            id={noteId}
            className={cn('col-start-1 text-xs', error ? 'text-danger' : 'text-fg-muted')}
          >
            {error ?? help}
          </p>
        ) : null}
      </div>
    </form>
  );
}
