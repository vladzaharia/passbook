import { Plus, X } from 'lucide-react';
import { Button, FormField, IconButton, Input, Select } from '../../../ui/index.ts';
import type { FieldDef } from '../schema-form/index.ts';
import { CHANGE_COPY as C } from './copy.ts';
import { type FieldRow, newRow, opLabel, opsFor, rowErrors } from './model.ts';
import { ValueControl } from './value-control.tsx';

const UNITS = (['D', 'W', 'M', 'Y'] as const).map((value) => ({ value, label: C.units[value] }));

/** One row per field: which field, what to do, and with what. */
export function FieldRows({
  fields,
  rows,
  onChange,
  showErrors,
  timeZone,
}: {
  fields: readonly FieldDef[];
  rows: readonly FieldRow[];
  onChange: (rows: FieldRow[]) => void;
  showErrors: boolean;
  timeZone: string;
}) {
  const errors = rowErrors(rows);
  const free = fields.filter((f) => !rows.some((r) => r.key === f.key));
  const patch = (id: string, next: Partial<FieldRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...next } : r)));
  return (
    <div className="flex flex-col gap-3">
      <ul className="wl-stagger flex flex-col gap-3" aria-label={C.fields.legend}>
        {rows.map((row, i) => {
          const field = fields.find((f) => f.key === row.key);
          const ops = opsFor(field);
          const error = showErrors ? errors[row.id] : undefined;
          return (
            <li
              key={row.id}
              style={{ '--i': i } as React.CSSProperties}
              className="grid items-start gap-3 rounded-lg border border-border bg-surface-raised p-3 sm:grid-cols-[minmax(0,1fr)_9.5rem_minmax(0,1.3fr)_auto]"
            >
              <FormField label={C.fields.field}>
                {(control) => (
                  <Select
                    {...control}
                    options={[...fields.filter((f) => f.key === row.key || free.includes(f))].map(
                      (f) => ({ value: f.key, label: f.label }),
                    )}
                    value={row.key}
                    onValueChange={(key) => patch(row.id, { key, op: 'set', value: undefined })}
                  />
                )}
              </FormField>
              <FormField label={C.fields.operation}>
                {(control) => (
                  <Select
                    {...control}
                    options={ops.map((o) => ({ value: o, label: opLabel(o) }))}
                    value={row.op}
                    onValueChange={(op) => patch(row.id, { op: op as FieldRow['op'] })}
                  />
                )}
              </FormField>
              {row.op === 'clear' ? (
                <p className="self-end pb-2 text-sm text-fg-muted">
                  {C.fields.emptied(field?.label ?? row.key)}
                </p>
              ) : row.op === 'set' && field ? (
                <FormField label="Value" error={error}>
                  {(control) => (
                    <ValueControl
                      field={field}
                      value={row.value}
                      onChange={(value) => patch(row.id, { value })}
                      control={control}
                      timeZone={timeZone}
                    />
                  )}
                </FormField>
              ) : (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <FormField label={C.fields.amount} error={error}>
                    {(control) => (
                      <Input
                        {...control}
                        inputMode="decimal"
                        value={row.amount}
                        onChange={(e) => patch(row.id, { amount: e.target.value })}
                      />
                    )}
                  </FormField>
                  {row.op === 'extend' || row.op === 'shorten' ? (
                    <FormField label={C.fields.unit}>
                      {(control) => (
                        <Select
                          {...control}
                          options={UNITS}
                          value={row.unit}
                          onValueChange={(unit) =>
                            patch(row.id, { unit: unit as FieldRow['unit'] })
                          }
                        />
                      )}
                    </FormField>
                  ) : null}
                </div>
              )}
              <IconButton
                className="max-sm:order-first max-sm:justify-self-end sm:mt-7"
                label={C.fields.remove(field?.label ?? row.key)}
                icon={<X aria-hidden />}
                onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
              />
            </li>
          );
        })}
      </ul>
      {fields.length === 0 ? <p className="text-sm text-fg-muted">{C.fields.none}</p> : null}
      <div>
        <Button
          variant="outline"
          iconStart={<Plus aria-hidden />}
          disabled={free.length === 0}
          onClick={() => {
            const first = free[0];
            if (first) onChange([...rows, newRow(first.key, crypto.randomUUID())]);
          }}
        >
          {C.fields.add}
        </Button>
      </div>
    </div>
  );
}
