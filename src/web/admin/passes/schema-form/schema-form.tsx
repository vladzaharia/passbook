import { RotateCcw } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  CheckboxField,
  FileDrop,
  FormField,
  Input,
  Select,
  Switch,
  Textarea,
} from '../../../ui/index.ts';
import { DateTimeInput } from './datetime-input.tsx';
import { describeSchema, type FieldDef, type FormValues, validateValues } from './schema.ts';

export type FieldSources = Record<string, 'manual' | 'connection'>;

export interface SchemaFormProps {
  schema: unknown;
  value: FormValues;
  onChange: (next: FormValues) => void;
  /** Messages from the server, by field key. Shown regardless of touch state. */
  serverErrors?: Record<string, string> | undefined;
  /** Show every validation error, e.g. after a failed submit. */
  showAllErrors?: boolean;
  disabled?: boolean;
  idPrefix?: string;
  /** Adds a manual/connection badge per field. */
  fieldSources?: FieldSources | undefined;
  onResetField?: ((key: string) => void) | undefined;
  /** Fields that are managed elsewhere and not rendered. */
  hiddenKeys?: ReadonlySet<string> | undefined;
  /** Max bytes for image widgets (stored as data URIs). */
  maxImageBytes?: number;
}

const NONE = '__none__';

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface InputProps {
  field: FieldDef;
  value: unknown;
  onValue: (v: unknown) => void;
  onBlur: () => void;
  control: Record<string, unknown>;
  disabled?: boolean | undefined;
  maxImageBytes: number;
}

function Control({ field, value, onValue, onBlur, control, disabled, maxImageBytes }: InputProps) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const common = { ...control, disabled, onBlur, placeholder: field.placeholder };
  switch (field.widget) {
    case 'boolean':
      return (
        <Switch
          id={control.id as string}
          aria-describedby={control['aria-describedby'] as string | undefined}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(c) => {
            onValue(c);
            onBlur();
          }}
        />
      );
    case 'select':
      return (
        <Select
          id={control.id as string}
          aria-describedby={control['aria-describedby'] as string | undefined}
          aria-invalid={control['aria-invalid'] === true}
          disabled={disabled}
          value={text === '' ? (field.required || field.hasDefault ? undefined : NONE) : text}
          onValueChange={(v) => {
            onValue(v === NONE ? undefined : coerceOption(field, v));
            onBlur();
          }}
          options={[
            ...(field.required || field.hasDefault ? [] : [{ value: NONE, label: 'None' }]),
            ...(field.options ?? []),
          ]}
        />
      );
    case 'textarea':
      return <Textarea {...common} value={text} onChange={(e) => onValue(e.target.value)} />;
    case 'number':
      return (
        <Input
          {...common}
          type="number"
          inputMode="decimal"
          value={text}
          onChange={(e) => onValue(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    case 'date':
      return (
        <Input {...common} type="date" value={text} onChange={(e) => onValue(e.target.value)} />
      );
    case 'datetime':
      return field.required ? (
        <DateTimeInput {...common} value={text} onValue={onValue} />
      ) : (
        <OptionalDateTime {...common} field={field} value={text} onValue={onValue} />
      );
    case 'image':
      return <ImageInput {...common} text={text} onValue={onValue} maxBytes={maxImageBytes} />;
    case 'email':
      return (
        <Input {...common} type="email" value={text} onChange={(e) => onValue(e.target.value)} />
      );
    case 'url':
      return (
        <Input {...common} type="url" value={text} onChange={(e) => onValue(e.target.value)} />
      );
    case 'password':
      return (
        <Input
          {...common}
          type="password"
          autoComplete="off"
          value={text}
          onChange={(e) => onValue(e.target.value)}
        />
      );
    default:
      return <Input {...common} value={text} onChange={(e) => onValue(e.target.value)} />;
  }
}

function OptionalDateTime({
  field,
  value,
  onValue,
  ...rest
}: {
  field: FieldDef;
  value: string;
  onValue: (v: string | undefined) => void;
} & Record<string, unknown>) {
  const [wantsNone, setNone] = useState(value === '');
  const none = wantsNone && value === '';
  return (
    <div className="flex flex-col gap-2">
      <DateTimeInput
        {...(rest as { onBlur: () => void })}
        value={value}
        onValue={onValue}
        disabled={none || rest.disabled === true}
      />
      <CheckboxField
        label={field.noneLabel}
        checked={none}
        disabled={rest.disabled === true}
        onCheckedChange={(c) => {
          setNone(c === true);
          if (c === true) onValue(undefined);
        }}
      />
    </div>
  );
}

function coerceOption(field: FieldDef, raw: string): unknown {
  if (field.type === 'number' || field.type === 'integer') return Number(raw);
  if (field.type === 'boolean') return raw === 'true';
  return raw;
}

function ImageInput({
  text,
  onValue,
  maxBytes,
  ...rest
}: {
  text: string;
  onValue: (v: unknown) => void;
  maxBytes: number;
} & Record<string, unknown>) {
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-col gap-2">
      <Input
        {...(rest as object)}
        type="url"
        value={text.startsWith('data:') ? '' : text}
        placeholder="https://"
        onChange={(e) => onValue(e.target.value)}
      />
      <FileDrop
        accept="image/png,image/jpeg"
        label={text.startsWith('data:') ? 'Replace image' : 'Upload image'}
        maxBytes={maxBytes}
        disabled={rest.disabled === true}
        onFiles={async ([file]) => {
          if (!file) return;
          try {
            setError(undefined);
            onValue(await readDataUrl(file));
          } catch {
            setError('Could not read the file.');
          }
        }}
      />
      {text.startsWith('data:') ? (
        <div className="flex items-center gap-3">
          <img src={text} alt="" className="size-12 rounded-sm border border-border object-cover" />
          <Button variant="ghost" size="sm" onClick={() => onValue(undefined)}>
            Remove
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Form generated from a template input schema (JSON Schema plus x- hints). */
export function SchemaForm({
  schema,
  value,
  onChange,
  serverErrors,
  showAllErrors,
  disabled,
  idPrefix,
  fieldSources,
  onResetField,
  hiddenKeys,
  maxImageBytes = 256 * 1024,
}: SchemaFormProps) {
  const groups = useMemo(
    () =>
      describeSchema(schema)
        .map((g) => ({ ...g, fields: g.fields.filter((f) => !hiddenKeys?.has(f.key)) }))
        .filter((g) => g.fields.length > 0),
    [schema, hiddenKeys],
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const errors = useMemo(() => validateValues(schema, value), [schema, value]);

  if (groups.length === 0)
    return <p className="text-sm text-fg-muted">This template has no inputs.</p>;

  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined || v === '') delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)));

  return (
    <div className="flex flex-col gap-6" data-prefix={idPrefix}>
      {groups.map((group) => {
        const body: ReactNode = (
          <div key={group.name} className="grid gap-4 sm:grid-cols-2">
            {group.fields.map((field) => {
              const error =
                serverErrors?.[field.key] ??
                (showAllErrors || touched.has(field.key) ? errors[field.key] : undefined);
              const source = fieldSources?.[field.key];
              const wide = field.widget === 'textarea' || field.widget === 'image';
              return (
                <FormField
                  key={field.key}
                  className={wide ? 'sm:col-span-2' : undefined}
                  label={
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {field.label}
                      {source ? (
                        <Badge tone={source === 'manual' ? 'warning' : 'info'}>
                          {source === 'manual' ? 'Manual' : 'Connection'}
                        </Badge>
                      ) : null}
                    </span>
                  }
                  help={
                    source === 'manual' && onResetField ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {field.help}
                        <Button
                          variant="link"
                          size="sm"
                          iconStart={<RotateCcw aria-hidden />}
                          disabled={disabled}
                          onClick={() => onResetField(field.key)}
                          aria-label={`Reset ${field.label} to connection`}
                        >
                          Reset to connection
                        </Button>
                      </span>
                    ) : (
                      field.help
                    )
                  }
                  error={error}
                  required={field.required}
                >
                  {(control) => (
                    <Control
                      field={field}
                      value={value[field.key]}
                      onValue={(v) => set(field.key, v)}
                      onBlur={() => touch(field.key)}
                      control={control as unknown as Record<string, unknown>}
                      disabled={disabled}
                      maxImageBytes={maxImageBytes}
                    />
                  )}
                </FormField>
              );
            })}
          </div>
        );
        return group.name ? (
          <fieldset key={group.name} className="min-w-0">
            <legend className="mb-3 text-sm font-semibold text-fg-strong">{group.name}</legend>
            {body}
          </fieldset>
        ) : (
          <div key="_">{body}</div>
        );
      })}
    </div>
  );
}
