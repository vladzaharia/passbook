import { Plus, X } from 'lucide-react';
import {
  Button,
  CheckboxField,
  FormField,
  IconButton,
  Input,
  NumberField,
  SegmentedControl,
  Select,
} from '../../ui/index.ts';
import type { FieldDef } from '../passes/schema-form/index.ts';
import { type Clause, emptyClause, MAX_CLAUSES } from './rule-state.ts';

const KINDS = new Set<FieldDef['widget']>([
  'select',
  'boolean',
  'text',
  'number',
  'date',
  'datetime',
]);
/** Inputs a condition can test. */
export const matchable = (fields: readonly FieldDef[]) => fields.filter((f) => KINDS.has(f.widget));

type Patch = (patch: Partial<Clause>) => void;

function Values({ clause, field, patch }: { clause: Clause; field: FieldDef; patch: Patch }) {
  if (field.widget === 'number')
    return (
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="From">
          {(c) => (
            <NumberField
              {...c}
              value={clause.min === '' ? null : Number(clause.min)}
              onValueChange={(v) => patch({ min: v === null ? '' : String(v) })}
            />
          )}
        </FormField>
        <FormField label="To">
          {(c) => (
            <NumberField
              {...c}
              value={clause.max === '' ? null : Number(clause.max)}
              onValueChange={(v) => patch({ max: v === null ? '' : String(v) })}
            />
          )}
        </FormField>
      </div>
    );
  if (field.widget === 'date' || field.widget === 'datetime')
    return (
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="From">
          {(c) => (
            <Input
              {...c}
              type="date"
              value={clause.from}
              onChange={(e) => patch({ from: e.target.value })}
            />
          )}
        </FormField>
        <FormField label="To">
          {(c) => (
            <Input
              {...c}
              type="date"
              value={clause.to}
              onChange={(e) => patch({ to: e.target.value })}
            />
          )}
        </FormField>
      </div>
    );
  if (field.widget === 'boolean')
    return (
      <SegmentedControl
        label="Value"
        options={[
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ]}
        value={clause.values[0] ?? ''}
        onValueChange={(v) => patch({ values: [v] })}
      />
    );
  if (field.widget === 'select' && field.options)
    return (
      <fieldset className="flex min-w-0 flex-wrap gap-x-4">
        <legend className="sr-only">Is one of</legend>
        {[
          ...field.options,
          // A saved value the template no longer offers stays visible, so it can be cleared.
          ...clause.values
            .filter((v) => !field.options?.some((o) => o.value === v))
            .map((v) => ({ value: v, label: v })),
        ].map((o) => (
          <CheckboxField
            key={o.value}
            label={o.label}
            checked={clause.values.includes(o.value)}
            onCheckedChange={(on) =>
              patch({
                values:
                  on === true
                    ? [...clause.values, o.value]
                    : clause.values.filter((v) => v !== o.value),
              })
            }
          />
        ))}
      </fieldset>
    );
  return (
    <FormField label="Is">
      {(c) => (
        <Input
          {...c}
          maxLength={120}
          value={clause.values[0] ?? ''}
          onChange={(e) => patch({ values: e.target.value ? [e.target.value] : [] })}
        />
      )}
    </FormField>
  );
}

/** "Only passes where": 1 to 3 conditions on inputs, all of which must hold. */
export function MatchEditor({
  fields,
  value,
  onChange,
  error,
}: {
  fields: readonly FieldDef[];
  value: Clause[];
  onChange: (next: Clause[]) => void;
  error?: string | undefined;
}) {
  const usable = matchable(fields);
  const byKey = new Map(usable.map((f) => [f.key, f]));
  const set = (i: number, patch: Partial<Clause>) =>
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-fg-strong">Only passes where</p>
      {value.map((clause, i) => {
        const field = byKey.get(clause.input);
        return (
          // Rows have no identity beyond their place.
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions are edited in place
          <div key={i} className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="flex items-end gap-2">
              <FormField label="Input" className="min-w-0 flex-1">
                {(c) => (
                  <Select
                    {...c}
                    placeholder="Choose an input"
                    options={usable.map((f) => ({ value: f.key, label: f.label }))}
                    value={clause.input || undefined}
                    onValueChange={(input) =>
                      onChange(value.map((x, j) => (j === i ? emptyClause(input) : x)))
                    }
                  />
                )}
              </FormField>
              <IconButton
                label="Remove condition"
                icon={<X aria-hidden />}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              />
            </div>
            {field ? <Values clause={clause} field={field} patch={(p) => set(i, p)} /> : null}
          </div>
        );
      })}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
      {value.length < MAX_CLAUSES ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={usable.length === 0}
            onClick={() => onChange([...value, emptyClause()])}
          >
            <Plus aria-hidden /> Add condition
          </Button>
        </div>
      ) : null}
    </div>
  );
}
