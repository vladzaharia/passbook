import type { ScanCond } from '@/passkit/template/scan-display/schema.ts';
import { Button, Combobox, FormField, Select } from '../../../../ui/index.ts';
import { isRecord } from '../model.ts';
import { inputSchema, type Leaf, leafOperator, leafPath } from './scan-condition-model.ts';
import { DaysBounds, initialValue, NumberValue, ScalarValue } from './scan-condition-values.tsx';
import { editorKey, useEditorKeys } from './scan-field-keys.ts';
import { type Manifest, type Option, pickerPaths } from './scan-fields.tsx';

export function ConditionLeaf({
  value,
  onChange,
  options,
  manifest,
  mergeKey,
}: {
  value: Leaf;
  onChange: (value: ScanCond, merge?: string) => void;
  options: Option[];
  manifest: Manifest;
  mergeKey: string;
}) {
  const path = leafPath(value);
  const op = leafOperator(value);
  const schema = inputSchema(manifest, path);
  const available = pickerPaths(options).has(path);
  const fieldOptions = available
    ? options
    : [{ value: '__unavailable', label: 'Unavailable field', disabled: true }, ...options];
  const base = () => ('input' in value ? { input: value.input } : { path: value.path });
  const setOp = (operator: string, newPath?: string) => {
    const dest = newPath ? { path: newPath } : base();
    const defaults: Record<string, unknown> = {
      eq: initialValue(newPath ? inputSchema(manifest, newPath) : schema),
      in: [initialValue(newPath ? inputSchema(manifest, newPath) : schema)],
      empty: true,
      gt: 0,
      gte: 0,
      lt: 0,
      lte: 0,
      daysFromNow: { lte: 30 },
    };
    if ('input' in dest && ['gt', 'gte', 'lt', 'lte', 'daysFromNow'].includes(operator))
      onChange({ path: `inputs.${dest.input}`, [operator]: defaults[operator] } as ScanCond);
    else onChange({ ...dest, [operator]: defaults[operator] } as ScanCond);
  };
  const set = (next: unknown, merge?: string) =>
    onChange({ ...base(), [op]: next } as ScanCond, merge);
  const raw = (value as unknown as Record<string, unknown>)[op];
  const values = op === 'in' && Array.isArray(raw) ? raw : [];
  const { keys: valueKeys, items: keyedValues, remember: rememberValues } = useEditorKeys(values);
  const setValues = (next: unknown[], nextKeys: string[], merge?: string) => {
    rememberValues(next, nextKeys);
    set(next, merge);
  };
  return (
    <>
      <FormField label="Condition field">
        {(control) => (
          <Combobox
            {...control}
            options={fieldOptions}
            value={available ? path : '__unavailable'}
            placeholder="Choose field"
            searchPlaceholder="Find a condition field"
            onValueChange={(next) => {
              if (pickerPaths(options).has(next)) setOp(op, next);
            }}
          />
        )}
      </FormField>
      {!available ? (
        <p className="text-sm text-fg-muted">
          This field is not available to this audience. The condition is preserved until you choose
          another field.
        </p>
      ) : (
        <>
          <FormField label="Comparison">
            {(control) => (
              <Select
                {...control}
                value={op}
                options={[
                  { value: 'eq', label: 'Equals' },
                  { value: 'in', label: 'Is one of' },
                  { value: 'empty', label: 'Is empty / present' },
                  { value: 'gt', label: 'Greater than' },
                  { value: 'gte', label: 'At least' },
                  { value: 'lt', label: 'Less than' },
                  { value: 'lte', label: 'At most' },
                  { value: 'daysFromNow', label: 'Days from now' },
                ]}
                onValueChange={(next) => setOp(next)}
              />
            )}
          </FormField>
          {op === 'empty' ? (
            <FormField label="Presence">
              {(control) => (
                <Select
                  {...control}
                  value={raw === false ? 'present' : 'empty'}
                  options={[
                    { value: 'empty', label: 'Is empty' },
                    { value: 'present', label: 'Is present' },
                  ]}
                  onValueChange={(v) => set(v === 'empty')}
                />
              )}
            </FormField>
          ) : null}
          {op === 'eq' ? (
            <ScalarValue
              label="Value"
              value={raw}
              schema={schema}
              mergeKey={`${mergeKey}:value`}
              onChange={set}
            />
          ) : null}
          {op === 'in' && Array.isArray(raw) ? (
            <div className="grid gap-2">
              <span className="text-sm font-medium">Values</span>
              {keyedValues.map(({ value: item, key }, index) => (
                <div key={key} className="grid gap-2">
                  <ScalarValue
                    label={`Value ${index + 1}`}
                    value={item}
                    schema={schema}
                    mergeKey={`${mergeKey}:value:${index}`}
                    onChange={(v, merge) =>
                      setValues(
                        raw.map((old, i) => (i === index ? v : old)),
                        valueKeys,
                        merge,
                      )
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="justify-self-start"
                    onClick={() =>
                      setValues(
                        raw.filter((_, i) => i !== index),
                        valueKeys.filter((_, i) => i !== index),
                      )
                    }
                  >
                    Remove value {index + 1}
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="justify-self-start"
                disabled={raw.length >= 20}
                onClick={() =>
                  setValues([...raw, initialValue(schema)], [...valueKeys, editorKey()])
                }
              >
                Add value
              </Button>
            </div>
          ) : null}
          {['gt', 'gte', 'lt', 'lte'].includes(op) && typeof raw === 'number' ? (
            <NumberValue label="Value" value={raw} mergeKey={`${mergeKey}:value`} onChange={set} />
          ) : null}
          {op === 'daysFromNow' && isRecord(raw) ? (
            <DaysBounds value={raw} onChange={set} mergeKey={mergeKey} />
          ) : null}
        </>
      )}
    </>
  );
}
