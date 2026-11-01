import { type ComponentProps, type ReactNode, useId } from 'react';
import { Label } from './label.tsx';
import { Switch } from './switch.tsx';

/** Persisted boolean: label (and help) left, switch right. */
export function SwitchRow({
  label,
  help,
  ...props
}: { label: ReactNode; help?: ReactNode } & Omit<ComponentProps<typeof Switch>, 'id'>) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-fg-strong">
          {label}
        </Label>
        {help ? (
          <p id={helpId} className="mt-0.5 text-xs text-fg-muted">
            {help}
          </p>
        ) : null}
      </div>
      <Switch id={id} aria-describedby={helpId} {...props} />
    </div>
  );
}
