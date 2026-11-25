import { RULE_COPY, ruleSummary } from '@/shared/copy/message-rules.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { zoneOptions } from '../../lib/timezones.ts';
import {
  Combobox,
  DependentSettings,
  FormField,
  Input,
  NumberField,
  Select,
  SwitchRow,
} from '../../ui/index.ts';
import type { FieldDef } from '../passes/schema-form/index.ts';
import { keyLabel, LAST_SCAN, type RuleField, type RuleState } from './rule-state.ts';

type Patch = (patch: Partial<RuleState>) => void;

/** "7 [days] [before] [Expiry]", every year, and the time of day. */
export function RuleWhen({
  state,
  onChange,
  fields,
  errors,
}: {
  state: RuleState;
  onChange: Patch;
  /** The inputs every chosen template has. */
  fields: readonly FieldDef[];
  errors: Partial<Record<RuleField, string>>;
}) {
  const dates = fields.filter((f) => f.widget === 'date' || f.widget === 'datetime');
  const anchors = [
    ...dates.map((f) => ({ value: f.key, label: f.label })),
    ...(state.anchor && state.anchor !== LAST_SCAN && !dates.some((f) => f.key === state.anchor)
      ? [{ value: state.anchor, label: keyLabel(state.anchor) }]
      : []),
    { value: LAST_SCAN, label: 'Last visit' },
  ];
  const lastScan = state.anchor === LAST_SCAN;
  const anchorField = dates.find((f) => f.key === state.anchor);
  const hoursOk = anchorField?.widget === 'datetime';
  const anchorText = anchors.find((a) => a.value === state.anchor)?.label ?? '';
  const pick = (anchor: string) =>
    onChange(
      anchor === LAST_SCAN
        ? {
            anchor,
            unit: 'day',
            when: 'after',
            yearly: false,
            amount: Math.max(state.amount ?? 1, 1),
          }
        : {
            anchor,
            ...(dates.find((f) => f.key === anchor)?.widget === 'datetime'
              ? {}
              : { unit: 'day' as const }),
          },
    );
  const summary =
    state.anchor && state.amount !== null
      ? ruleSummary({
          anchorLabel: lastScan ? 'the last scan' : anchorText,
          offset: { amount: state.amount, unit: state.unit, when: state.when },
          yearly: state.yearly,
          sendAt: state.sendAt,
        })
      : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_1.4fr] sm:items-start">
        <FormField label="Amount" error={errors.offset}>
          {(c) => (
            <NumberField
              {...c}
              min={lastScan ? 1 : 0}
              max={366}
              className="w-full sm:w-24"
              value={state.amount}
              onValueChange={(amount) => onChange({ amount })}
            />
          )}
        </FormField>
        <FormField label="Unit">
          {(c) => (
            <Select
              {...c}
              options={[
                { value: 'day', label: 'days' },
                { value: 'hour', label: 'hours', disabled: !hoursOk || lastScan },
              ]}
              value={state.unit}
              onValueChange={(unit) => onChange({ unit: unit as RuleState['unit'] })}
            />
          )}
        </FormField>
        <FormField label="Direction">
          {(c) => (
            <Select
              {...c}
              options={[
                { value: 'before', label: 'before', disabled: lastScan },
                { value: 'after', label: 'after' },
              ]}
              value={state.when}
              onValueChange={(when) => onChange({ when: when as RuleState['when'] })}
            />
          )}
        </FormField>
        <FormField label="Counting from" error={errors.anchor}>
          {(c) => (
            <Select
              {...c}
              placeholder="Choose a date"
              options={anchors}
              value={state.anchor || undefined}
              onValueChange={pick}
            />
          )}
        </FormField>
      </div>
      {state.anchor && !hoursOk && !lastScan ? (
        <p className="-mt-2 text-xs text-fg-muted">{RULE_COPY.hoursNeedDateTime}</p>
      ) : null}
      {lastScan ? null : (
        <SwitchRow
          label="Every year"
          help={errors.yearly}
          checked={state.yearly}
          disabled={state.unit !== 'day'}
          onCheckedChange={(yearly) => onChange({ yearly })}
        />
      )}
      <DependentSettings open={state.unit === 'day'}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Send at" error={errors.sendAt}>
            {(c) => (
              <Input
                {...c}
                type="time"
                value={state.sendAt}
                onChange={(e) => onChange({ sendAt: e.target.value })}
              />
            )}
          </FormField>
          <FormField label="Time zone">
            {(c) => (
              <Combobox
                id={c.id}
                searchPlaceholder="Find a city"
                options={zoneOptions()}
                value={state.timeZone || DEFAULT_TIME_ZONE}
                onValueChange={(timeZone) => onChange({ timeZone })}
              />
            )}
          </FormField>
        </div>
      </DependentSettings>
      {summary ? <p className="text-sm text-fg-muted">{summary}</p> : null}
    </div>
  );
}
