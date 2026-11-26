import { Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { zoneOptions } from '../../../lib/timezones.ts';
import { Button, Combobox, FileDrop, Input, Select, Switch, Textarea } from '../../../ui/index.ts';
import { AccessPlanInput } from '../inputs/access-plan.tsx';
import { AccessZonesInput } from '../inputs/access-zones.tsx';
import { DateTimeInput } from './datetime-input.tsx';
import type { FieldDef } from './schema.ts';

const NONE = '__none__';

/** Widgets that take the full width of their grid. */
export const WIDE_WIDGETS: ReadonlySet<string> = new Set([
  'textarea',
  'image',
  'datetime',
  'url',
  'list',
  'access-plan',
  'access-zones',
]);

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface InputProps {
  field: FieldDef;
  value: unknown;
  onValue: (v: unknown) => void;
  onBlur: () => void;
  control: Record<string, unknown>;
  disabled?: boolean | undefined;
  maxImageBytes: number;
  /** The template's time zone input, when it has one. */
  zone?: string | undefined;
  /** The org's zone: where a date-time with no venue zone and no written offset is read. */
  orgZone?: string | undefined;
}

export function Control({
  field,
  value,
  onValue,
  onBlur,
  control,
  disabled,
  maxImageBytes,
  zone,
  orgZone,
}: InputProps) {
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
          value={
            text === ''
              ? field.hasDefault
                ? String(field.schema.default)
                : field.required
                  ? undefined
                  : NONE
              : text
          }
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
          {...(field.hasDefault ? { placeholder: String(field.schema.default) } : {})}
          value={text}
          onChange={(e) => onValue(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    case 'date': {
      // A calendar date stored in a date-time input is midnight UTC, which ignoresTimeZone shows as is.
      const instant = field.schema.format === 'date-time';
      return (
        <Input
          {...common}
          type="date"
          value={instant ? text.slice(0, 10) : text}
          onChange={(e) => {
            const day = e.target.value;
            onValue(instant ? (day ? `${day}T00:00:00Z` : undefined) : day);
          }}
        />
      );
    }
    case 'datetime':
      return (
        <DateTimeInput
          {...common}
          value={text}
          onValue={onValue}
          zone={zone}
          orgZone={orgZone}
          clearLabel={field.required ? undefined : field.noneLabel}
        />
      );
    case 'timezone':
      return (
        <Combobox
          id={control.id as string}
          searchPlaceholder="Find a city"
          placeholder="Choose a time zone"
          disabled={disabled === true}
          options={zoneOptions()}
          value={text || undefined}
          onValueChange={(z) => {
            onValue(z);
            onBlur();
          }}
        />
      );
    case 'access-plan':
      return (
        <AccessPlanInput
          field={field}
          value={value}
          control={control}
          disabled={disabled}
          onValue={(v) => {
            onValue(v);
            onBlur();
          }}
        />
      );
    case 'access-zones':
      return (
        <AccessZonesInput
          field={field}
          value={value}
          control={control}
          disabled={disabled}
          onValue={(v) => {
            onValue(v);
            onBlur();
          }}
        />
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
      return <PasswordInput {...common} value={text} onValue={onValue} />;
    default:
      return <Input {...common} value={text} onChange={(e) => onValue(e.target.value)} />;
  }
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

/** Masked by default; Show lets the admin check what they typed. */
function PasswordInput({
  onValue,
  ...props
}: ComponentProps<typeof Input> & { onValue: (v: string) => void }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input
        {...props}
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        onChange={(e) => onValue(e.target.value)}
      />
      <Button
        variant="ghost"
        size="sm"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
        disabled={props.disabled}
      >
        {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        {shown ? 'Hide' : 'Show'}
      </Button>
    </div>
  );
}
