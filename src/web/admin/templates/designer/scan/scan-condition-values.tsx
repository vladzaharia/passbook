import { useState } from 'react';
import { Button, FormField, Input, Select } from '../../../../ui/index.ts';
import type { Option } from './scan-fields.tsx';
import { safePreviewNumber, safePreviewText } from './scan-preview-policy.ts';
import { useRejection } from './use-rejection.ts';

const scalar = (value: unknown): value is string | number | boolean | null =>
  value === null ||
  typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  typeof value === 'boolean';

/** Condition values are template data too: never surface contact-like or opaque identifier text. */
const safeScalar = (value: unknown): value is string | number | boolean | null => {
  if (!scalar(value)) return false;
  if (typeof value === 'number') return safePreviewNumber(String(value));
  if (typeof value !== 'string') return true;
  // A short code like VIP2 is a value; a long mixed run (nine or more) reads as an opaque token.
  return (
    value.length <= 80 &&
    safePreviewText(value) &&
    !/^(?=.*[a-z])(?=.*\d)[a-z0-9_-]{9,}$/i.test(value)
  );
};

export function initialValue(schema: Record<string, unknown>): string | number | boolean | null {
  const first = Array.isArray(schema.enum) ? schema.enum.find(safeScalar) : undefined;
  if (first !== undefined) return first;
  if (schema.type === 'number' || schema.type === 'integer') return 0;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'null') return null;
  return '';
}

export function NumberValue({
  label,
  value,
  onChange,
  mergeKey,
  min,
  max,
  integer = false,
}: {
  label: string;
  value: number;
  onChange: (v: number, merge?: string) => void;
  mergeKey: string;
  min?: number;
  max?: number;
  integer?: boolean;
}) {
  const [draft, setDraft] = useState(safeScalar(value) ? String(value) : '');
  const [seen, setSeen] = useState(value);
  const [fault, setFault] = useState<string | undefined>();
  if (seen !== value) {
    setSeen(value);
    setDraft(safeScalar(value) ? String(value) : '');
  }
  if (!safeScalar(value))
    return (
      <div className="grid gap-2 text-sm text-fg-muted">
        <span>{label}: Sensitive value hidden and preserved.</span>
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() => onChange(0)}
        >
          Replace value
        </Button>
      </div>
    );
  return (
    <FormField label={label} error={fault}>
      {(control) => (
        <Input
          {...control}
          type="number"
          step={integer ? 1 : 'any'}
          min={min}
          max={max}
          value={draft}
          onChange={(event) => {
            const text = event.target.value;
            if (text !== '' && !safePreviewNumber(text)) {
              setFault('Use fewer than 10 digits.');
              return;
            }
            setFault(undefined);
            setDraft(text);
            if (text.trim() === '') return;
            const number = Number(text);
            if (
              Number.isFinite(number) &&
              (!integer || Number.isInteger(number)) &&
              (min === undefined || number >= min) &&
              (max === undefined || number <= max)
            )
              onChange(number, mergeKey);
          }}
          onBlur={() => {
            setFault(undefined);
            const n = Number(draft);
            if (
              draft.trim() === '' ||
              !Number.isFinite(n) ||
              (integer && !Number.isInteger(n)) ||
              (min !== undefined && n < min) ||
              (max !== undefined && n > max)
            )
              setDraft(String(value));
          }}
        />
      )}
    </FormField>
  );
}

export function ScalarValue({
  label,
  value,
  schema,
  onChange,
  mergeKey,
}: {
  label: string;
  value: unknown;
  schema: Record<string, unknown>;
  onChange: (v: unknown, merge?: string) => void;
  mergeKey: string;
}) {
  const rejection = useRejection();
  const hasEnum = Array.isArray(schema.enum);
  const values = hasEnum ? (schema.enum as unknown[]).filter(safeScalar) : [];
  const enumIndex = values.findIndex((v) => Object.is(v, value));
  if (hasEnum && !values.length)
    return (
      <p className="text-sm text-fg-muted">
        {label}: No safe values available. The current value is preserved.
      </p>
    );
  if (values.length)
    return (
      <FormField label={label}>
        {(control) => (
          <Select
            {...control}
            value={enumIndex < 0 ? '__custom' : `v${enumIndex}`}
            options={[
              ...(enumIndex < 0
                ? [{ value: '__custom', label: 'Unavailable value (preserved)', disabled: true }]
                : []),
              ...values.map((v, i) => ({ value: `v${i}`, label: v === null ? 'Null' : String(v) })),
            ]}
            onValueChange={(v) => {
              const index = Number(v.slice(1));
              if (index >= 0 && index < values.length) onChange(values[index]);
            }}
          />
        )}
      </FormField>
    );
  if (!safeScalar(value))
    return (
      <div className="grid gap-2 text-sm text-fg-muted">
        <span>{label}: Unavailable value preserved.</span>
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => onChange(initialValue(schema))}
        >
          Replace value
        </Button>
      </div>
    );
  const type = value === null ? 'null' : typeof value;
  const control =
    typeof value === 'number' ? (
      <NumberValue
        label={label}
        value={value}
        mergeKey={mergeKey}
        integer={schema.type === 'integer'}
        onChange={onChange}
      />
    ) : typeof value === 'boolean' || value === null ? (
      <FormField label={label}>
        {(field) => (
          <Select
            {...field}
            value={value === null ? 'null' : String(value)}
            options={
              value === null
                ? [{ value: 'null', label: 'Null' }]
                : [
                    { value: 'true', label: 'True' },
                    { value: 'false', label: 'False' },
                  ]
            }
            onValueChange={(v) => onChange(v === 'null' ? null : v === 'true')}
          />
        )}
      </FormField>
    ) : (
      <FormField label={label} error={rejection.error}>
        {(field) => (
          <Input
            {...field}
            maxLength={80}
            value={value}
            onBlur={rejection.clear}
            onChange={(event) => {
              const text = event.target.value;
              const opaque = safeScalar(text) ? null : 'Too long for a code. Shorten it.';
              if (rejection.accept(text, 0, opaque)) onChange(text, mergeKey);
            }}
          />
        )}
      </FormField>
    );
  return (
    <div className="grid gap-2">
      {schema.type === undefined ? (
        <FormField label={`${label} type`}>
          {(field) => (
            <Select
              {...field}
              value={type}
              options={[
                { value: 'string', label: 'Text' },
                { value: 'number', label: 'Number' },
                { value: 'boolean', label: 'True or false' },
                { value: 'null', label: 'Null' },
              ]}
              onValueChange={(v) =>
                onChange(v === 'number' ? 0 : v === 'boolean' ? false : v === 'null' ? null : '')
              }
            />
          )}
        </FormField>
      ) : null}
      {control}
    </div>
  );
}

export function DaysBounds({
  value,
  onChange,
  mergeKey,
}: {
  value: Record<string, unknown>;
  onChange: (value: unknown, merge?: string) => void;
  mergeKey: string;
}) {
  const lower =
    typeof value.gt === 'number' ? 'gt' : typeof value.gte === 'number' ? 'gte' : 'none';
  const upper =
    typeof value.lt === 'number' ? 'lt' : typeof value.lte === 'number' ? 'lte' : 'none';
  const setBound = (side: 'lower' | 'upper', next: string) => {
    const copy = { ...value };
    const old = side === 'lower' ? lower : upper;
    if (old !== 'none') delete copy[old];
    if (next !== 'none') copy[next] = typeof value[old] === 'number' ? value[old] : 0;
    if (Object.keys(copy).length) onChange(copy);
  };
  const bound = (side: 'lower' | 'upper', current: string, other: string, choices: Option[]) => (
    <div className="grid gap-2">
      <FormField label={`${side === 'lower' ? 'Minimum' : 'Maximum'} days`}>
        {(control) => (
          <Select
            {...control}
            value={current}
            options={choices.map((o) =>
              o.value === 'none' && other === 'none' ? { ...o, disabled: true } : o,
            )}
            onValueChange={(v) => setBound(side, v)}
          />
        )}
      </FormField>
      {current !== 'none' && typeof value[current] === 'number' ? (
        <NumberValue
          label={`${side === 'lower' ? 'Minimum' : 'Maximum'} day count`}
          value={value[current] as number}
          mergeKey={`${mergeKey}:${current}`}
          onChange={(v, merge) => onChange({ ...value, [current]: v }, merge)}
        />
      ) : null}
    </div>
  );
  return (
    <div className="grid gap-3">
      {bound('lower', lower, upper, [
        { value: 'none', label: 'No minimum' },
        { value: 'gt', label: 'More than' },
        { value: 'gte', label: 'At least' },
      ])}
      {bound('upper', upper, lower, [
        { value: 'none', label: 'No maximum' },
        { value: 'lt', label: 'Less than' },
        { value: 'lte', label: 'At most' },
      ])}
    </div>
  );
}
