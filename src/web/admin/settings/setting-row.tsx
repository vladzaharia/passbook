import { useId } from 'react';
import { cn } from '@/web/lib/cn.ts';
import { Input, Label, NumberField, SwitchRow } from '@/web/ui/index.ts';
import type { SettingField } from './fields.ts';

export interface SettingRowProps {
  field: SettingField;
  value: string | boolean;
  error: string | undefined;
  /** Org pages stack label, control and help; the Settings page uses label-left rows. */
  flat: boolean;
  onChange: (v: string | boolean) => void;
}

const ROW = 'px-4 py-4';
const SPLIT = 'grid gap-x-8 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center';
/** Number fields stay beside their label on phones too, like switches. */
const SPLIT_NUMBER = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 md:gap-x-8';

function Control({
  field,
  value,
  id,
  describedBy,
  invalid,
  onChange,
}: Omit<SettingRowProps, 'error' | 'flat'> & {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}) {
  const aria = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined };
  if (field.kind === 'int') {
    const text = String(value).trim();
    return (
      <NumberField
        {...aria}
        unit={field.suffix}
        inputMode="numeric"
        step={1}
        value={text === '' ? null : Number(text)}
        onValueChange={(n) => onChange(n === null ? '' : String(n))}
      />
    );
  }
  const input = (
    <Input
      {...aria}
      className="w-full"
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
  if (field.kind !== 'color') return input;
  return (
    <div className="flex w-full items-center gap-2">
      <input
        type="color"
        aria-label={`${field.label} picker`}
        value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        className="size-9 shrink-0 cursor-pointer rounded-md border border-border-strong bg-transparent p-0.5"
      />
      {input}
    </div>
  );
}

/**
 * One setting. Help is xs muted; an error replaces it under the control. On the Settings page the
 * control column is flush right: switches and number fields end at the card's content edge, text
 * fields fill the column.
 */
export function SettingRow({ field, value, error, flat, onChange }: SettingRowProps) {
  const id = useId();
  if (field.kind === 'boolean') {
    return (
      <div className={cn(!flat && ROW)}>
        <SwitchRow
          label={field.label}
          help={field.help}
          checked={value === true}
          onCheckedChange={(c) => onChange(c)}
        />
      </div>
    );
  }
  const helpId = field.help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const help = field.help ? (
    <p id={helpId} className="text-xs text-fg-muted">
      {field.help}
    </p>
  ) : null;
  const control = (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1',
        !flat && (field.kind === 'int' ? 'items-end' : 'md:items-end'),
      )}
    >
      <Control
        field={field}
        value={value}
        id={id}
        describedBy={errorId ?? helpId}
        invalid={Boolean(error)}
        onChange={onChange}
      />
      {error ? (
        <p
          id={errorId}
          className={cn(
            'text-xs text-danger',
            !flat && (field.kind === 'int' ? 'text-right' : 'md:text-right'),
          )}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
  if (flat) {
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{field.label}</Label>
        {control}
        {error ? null : help}
      </div>
    );
  }
  return (
    <div className={cn(ROW, field.kind === 'int' ? SPLIT_NUMBER : SPLIT)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id} className="text-fg-strong">
          {field.label}
        </Label>
        {help}
      </div>
      {control}
    </div>
  );
}
