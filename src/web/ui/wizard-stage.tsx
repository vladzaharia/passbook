import { type ReactNode, useId } from 'react';

/**
 * The wizard's stage at 1024 and up: a full-height slice on the sunken surface, from the top bar
 * down to the wizard bar, right of the steps (the Wizard clears it). It stays put while the steps
 * scroll; content taller than the slice scrolls inside it.
 */
export function WizardStage({
  label,
  quiet,
  children,
}: {
  label: string;
  /** The label only names the landmark; the content already says it. */
  quiet?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <aside aria-labelledby={id} className="wl-stage">
      <p id={id} className={quiet ? 'sr-only' : 'px-6 pt-5 text-xs font-medium text-fg-muted'}>
        {label}
      </p>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4">{children}</div>
    </aside>
  );
}
