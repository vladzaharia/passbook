import { hoursText } from '@/passkit/template/access/scope.ts';
import type { AccessPlan } from '@/passkit/types.ts';

/** The chip and band staff see for a plan at the door. Inert: it shows, it does not act. */
export function ScannerStrip({ plan }: { plan: AccessPlan }) {
  const hours = plan.kind === 'always' ? 'Any time' : hoursText(plan.hours) || 'No hours yet';
  return (
    <figure
      aria-label={`On the scanner: ${plan.label}`}
      className="ac-strip m-0 grid gap-2 rounded-lg border border-border bg-surface-sunken p-3"
    >
      <figcaption className="text-xs font-medium uppercase tracking-wide text-fg-muted">
        On the scanner
      </figcaption>
      <div
        aria-hidden
        className="flex items-center justify-between gap-3 rounded-md bg-success-subtle px-3 py-2 text-success"
      >
        <span className="text-sm font-semibold">Let in</span>
        <span className="truncate rounded-full border border-success-border bg-surface-raised px-2.5 py-0.5 text-xs font-medium">
          {plan.label}
        </span>
      </div>
      <p aria-hidden className="truncate text-xs text-fg-muted">
        {hours}
      </p>
    </figure>
  );
}
