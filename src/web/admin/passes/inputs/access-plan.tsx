import { Clock, Infinity as InfinityIcon, Ticket } from 'lucide-react';
import { useId } from 'react';
import { OptionTile } from '../../../ui/index.ts';
import type { FieldDef } from '../schema-form/schema.ts';

const ICON = { always: InfinityIcon, timed: Clock, guest: Ticket } as const;

/**
 * The plans of the template as radio tiles: name, and under it the hours or the guest terms.
 * One tile is always on once the form has a plan; a form with none shows the choices unticked.
 */
export function AccessPlanInput({
  field,
  value,
  onValue,
  disabled,
  control,
}: {
  field: FieldDef;
  value: unknown;
  onValue: (planId: string | undefined) => void;
  disabled?: boolean | undefined;
  control: Record<string, unknown>;
}) {
  const name = useId();
  const plans = field.plans ?? [];
  if (plans.length === 0)
    return <p className="text-sm text-fg-muted">This template has no plans.</p>;
  return (
    <div
      role="radiogroup"
      id={control.id as string | undefined}
      aria-label={field.label}
      aria-invalid={control['aria-invalid'] === true ? true : undefined}
      aria-describedby={control['aria-describedby'] as string | undefined}
      className="@container grid gap-2"
    >
      <div className="grid gap-2 @md:grid-cols-2">
        {plans.map((plan) => (
          <OptionTile
            key={plan.id}
            name={name}
            value={plan.id}
            label={plan.label}
            description={plan.summary}
            icon={ICON[plan.kind]}
            checked={value === plan.id}
            disabled={disabled}
            onSelect={onValue}
          />
        ))}
      </div>
    </div>
  );
}
