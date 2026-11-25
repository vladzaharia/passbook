import { FormField, Input, NumberField, Select, SwitchRow } from '../../../ui/index.ts';
import type { Format } from './explorer-actions.ts';
import { type Incremental, incrementalErrors } from './rest-values.ts';

/** "Only fetch changes": asks the API for records changed since the last run, overlapping a little. */
export function IncrementalPanel({
  value,
  onChange,
  suggested,
  full,
  showErrors,
  disabled,
}: {
  value: Incremental | undefined;
  onChange: (next: Incremental | undefined) => void;
  /** The updated-time field the sample suggests or the user picked. */
  suggested: { field: string; format: Format } | undefined;
  full: boolean;
  showErrors: boolean;
  disabled?: boolean;
}) {
  const e = value && showErrors ? incrementalErrors(value) : {};
  const set = (patch: Partial<Incremental>) => value && onChange({ ...value, ...patch });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SwitchRow
        label="Only fetch changes"
        help={full ? undefined : 'Needs a full listing.'}
        checked={Boolean(value)}
        disabled={disabled || (!full && !value)}
        onCheckedChange={(on) =>
          onChange(
            on
              ? {
                  param: '',
                  field: suggested?.field ?? '',
                  format: suggested?.format ?? 'iso',
                  overlapSeconds: 300,
                }
              : undefined,
          )
        }
      />
      {value ? (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <FormField label="Query parameter" error={e.param}>
            {(f) => (
              <Input
                {...f}
                className="font-mono"
                value={value.param}
                placeholder="updated_since"
                disabled={disabled}
                onChange={(ev) => set({ param: ev.target.value })}
              />
            )}
          </FormField>
          <FormField label="Updated time" error={e.field}>
            {(f) => (
              <Input
                {...f}
                className="font-mono"
                value={value.field}
                placeholder="/updated_at"
                disabled={disabled}
                onChange={(ev) => set({ field: ev.target.value })}
              />
            )}
          </FormField>
          <FormField label="Time format">
            {(f) => (
              <Select
                {...f}
                disabled={disabled}
                value={value.format}
                onValueChange={(format) => set({ format: format as Format })}
                options={[
                  { value: 'iso', label: 'ISO 8601' },
                  { value: 'unix', label: 'Unix seconds' },
                  { value: 'unix-ms', label: 'Unix milliseconds' },
                ]}
              />
            )}
          </FormField>
          <FormField label="Overlap" error={e.overlap}>
            {(f) => (
              <NumberField
                {...f}
                unit="s"
                value={value.overlapSeconds}
                disabled={disabled}
                onValueChange={(n) => set({ overlapSeconds: n ?? 0 })}
              />
            )}
          </FormField>
        </div>
      ) : null}
    </div>
  );
}
