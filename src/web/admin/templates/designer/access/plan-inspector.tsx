import { Clock, Infinity as InfinityIcon, Ticket } from 'lucide-react';
import type { AccessPlan, ValidationIssue } from '@/passkit/types.ts';
import { FormField, NumberField, OptionTile, SwitchRow } from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import { TextEdit } from '../controls.tsx';
import { dayErrors } from './issues.ts';
import { LABEL_MAX } from './model.ts';
import type { PlanPatch } from './ops.ts';
import { WeekGrid } from './week-grid.tsx';
import { ZoneGrants } from './zone-grants.tsx';

const KINDS = [
  { value: 'always', label: '24/7', description: 'Any time.', icon: InfinityIcon },
  { value: 'timed', label: 'Timed', description: 'Set weekly hours.', icon: Clock },
  {
    value: 'guest',
    label: 'Guest',
    description: 'A few days, optional visit limit.',
    icon: Ticket,
  },
] as const;

function Heading({ children }: { children: string }) {
  return <h4 className="text-xs font-medium uppercase tracking-wide text-fg-muted">{children}</h4>;
}

/** One plan: its name, type, weekly hours, zones and, for a guest plan, how long and how often. */
export function PlanInspector({
  plan,
  issues,
}: {
  plan: AccessPlan;
  issues: readonly ValidationIssue[];
}) {
  const { edit } = useDesigner();
  const patch = (p: PlanPatch, merge?: string) =>
    edit({ op: 'access-plan-set', id: plan.id, patch: p }, merge);
  const labelIssue = issues.find(
    (i) => i.code === 'ACCESS_PLAN_LABEL' && i.path?.endsWith('.label'),
  );
  const rangeIssue = (key: string) =>
    issues.find((i) => i.code === 'ACCESS_GUEST_RANGE' && i.path?.endsWith(`.${key}`))?.message;
  const limitedHours = plan.kind === 'guest' && plan.hours !== undefined;
  return (
    <div className="dz-editor @container grid gap-5">
      <TextEdit
        label="Name"
        value={plan.label}
        merge={`plan-label:${plan.id}`}
        error={labelIssue?.message}
        inputProps={{ maxLength: LABEL_MAX + 8 }}
        op={(v) => ({ op: 'access-plan-set', id: plan.id, patch: { label: v } })}
      />
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium text-fg-strong">Type</legend>
        <div className="grid gap-2 @md:grid-cols-3">
          {KINDS.map((k) => (
            <OptionTile
              key={k.value}
              name={`kind-${plan.id}`}
              value={k.value}
              label={k.label}
              description={k.description}
              icon={k.icon}
              checked={plan.kind === k.value}
              onSelect={(v) =>
                edit({ op: 'access-plan-kind', id: plan.id, kind: v as AccessPlan['kind'] })
              }
            />
          ))}
        </div>
      </fieldset>
      {plan.kind === 'always' ? null : (
        <section className="grid gap-3" aria-label="Hours">
          <Heading>Hours</Heading>
          {plan.kind === 'guest' ? (
            <SwitchRow
              label="Limit to hours"
              checked={limitedHours}
              onCheckedChange={(on) => patch({ hours: on ? { mon: ['09:00-17:00'] } : null })}
            />
          ) : null}
          {plan.kind === 'timed' || limitedHours ? (
            <WeekGrid
              label={plan.label}
              hours={plan.hours}
              mergeKey={plan.id}
              errors={dayErrors(issues, null)}
              onChange={(hours, merge) =>
                patch({ hours: hours ?? (plan.kind === 'timed' ? {} : null) }, merge)
              }
            />
          ) : null}
        </section>
      )}
      <section className="grid gap-3" aria-label="Zones">
        <Heading>Zones</Heading>
        <ZoneGrants plan={plan} issues={issues} />
      </section>
      {plan.kind === 'guest' ? (
        <section className="grid gap-3" aria-label="Guest">
          <Heading>Guest</Heading>
          <div className="grid gap-4 @md:grid-cols-2">
            <FormField label="Lasts" help="Ends at midnight." error={rangeIssue('days')}>
              {(control) => (
                <NumberField
                  {...control}
                  unit="days"
                  min={1}
                  max={366}
                  placeholder="1"
                  value={plan.days ?? null}
                  onValueChange={(v) => patch({ days: v }, `plan-days:${plan.id}`)}
                />
              )}
            </FormField>
            <FormField label="Visit limit" help="No limit when empty." error={rangeIssue('visits')}>
              {(control) => (
                <NumberField
                  {...control}
                  unit="visits"
                  min={1}
                  max={999}
                  value={plan.visits ?? null}
                  onValueChange={(v) => patch({ visits: v }, `plan-visits:${plan.id}`)}
                />
              )}
            </FormField>
          </div>
        </section>
      ) : null}
    </div>
  );
}
