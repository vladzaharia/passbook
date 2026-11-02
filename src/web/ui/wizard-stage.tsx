import { type ReactNode, useId } from 'react';
import './wizard.css';

/**
 * The wizard's stage at 1024 and up: a full-height slice on the sunken surface, from the top bar
 * down to the wizard bar, right of the steps (the Wizard clears it). It stays put while the steps
 * scroll; content taller than the slice scrolls inside it.
 */
export function WizardStage({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <aside aria-labelledby={id} className="wl-stage">
      <p id={id} className="px-6 pt-5 text-xs font-medium text-fg-muted">
        {label}
      </p>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-4 pb-[calc(5rem+env(safe-area-inset-bottom))]">
        {children}
      </div>
    </aside>
  );
}
