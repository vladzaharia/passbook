import { useState } from 'react';
import { Button, FileDrop, Input, Select, Switch, Textarea } from '../../../ui/index.ts';
import { DateTimeInput } from './datetime-input.tsx';
import type { FieldDef } from './schema.ts';

const NONE = '__none__';

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
}

export function Control({
  field,
  value,
  onValue,
  onBlur,
  control,
  disabled,
  maxImageBytes,
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
      return (
        <DateTimeInput
          {...common}
          value={text}
          onValue={onValue}
          clearLabel={field.required ? undefined : field.noneLabel}
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
