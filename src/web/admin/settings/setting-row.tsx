import { type ReactNode, useId } from 'react';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { cn } from '@/web/lib/cn.ts';
import { localZone, zoneLabel, zoneOptions } from '@/web/lib/timezones.ts';
import { Button, Combobox, Input, Label, NumberField, SwitchRow } from '@/web/ui/index.ts';
import type { SettingField } from './fields.ts';

export interface SettingRowProps {
  field: SettingField;
  value: string | boolean;
  error: string | undefined;
  /** Org pages stack label, control and help; the Settings page uses label-left rows. */
  flat: boolean;
  help?: string;
  meta?: ReactNode;
  /** Org scope: the effective default shown in an empty input. */
  placeholder?: string;
  /** A platform kill switch is off: the control does nothing. */
  disabled?: boolean;
  /** Org scope: the reset reads "Use default". */
  inherits?: boolean;
  onReset?: () => void;
  onChange: (v: string | boolean) => void;
}

const UNSET = '__unset';

/** The zone an unset org follows, named the way the picker names it. */
function defaultZoneLabel(zone: string | undefined): string {
  const id = zone ?? DEFAULT_TIME_ZONE;
  return `${zoneLabel(id)} · default`;
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
  placeholder,
  disabled,
  onChange,
}: Omit<SettingRowProps, 'error' | 'flat' | 'inherits'> & {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}) {
  const aria = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': invalid || undefined,
    placeholder,
    disabled,
  };
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
  if (field.kind === 'zone')
    return (
      <Combobox
        id={id}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className="w-full"
        placeholder={defaultZoneLabel(placeholder)}
        searchPlaceholder="Search time zones"
        options={[{ value: UNSET, label: defaultZoneLabel(placeholder) }, ...zoneOptions()]}
        value={String(value) || undefined}
        onValueChange={(zone) => onChange(zone === UNSET ? '' : zone)}
      />
    );
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
export function SettingRow({
  field,
  value,
  error,
  flat,
  help: helpText,
  meta,
  placeholder,
  disabled,
  inherits,
  onReset,
  onChange,
}: SettingRowProps) {
  const id = useId();
  const description = helpText ?? field.help;
  // The browser's zone is offered, never saved on its own.
  const browserZone = field.kind === 'zone' && value === '' && !disabled ? localZone() : null;
  // A hint and its source read as one line when nothing else sits beside the source.
  const inlineMeta =
    field.kind !== 'boolean' && Boolean(description && meta && !onReset && !browserZone);
  const details =
    !inlineMeta && (meta || onReset || browserZone) ? (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
        {meta}
        {browserZone ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            aria-label={`Use ${zoneLabel(browserZone)}`}
            onClick={() => onChange(browserZone)}
          >
            Use {zoneLabel(browserZone)}
          </Button>
        ) : null}
        {onReset ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0"
            onClick={onReset}
            aria-label={
              inherits ? `Use default for ${field.label}` : `Reset ${field.label} to default`
            }
          >
            {inherits ? 'Use default' : 'Reset to default'}
          </Button>
        ) : null}
      </div>
    ) : null;
  if (field.kind === 'boolean') {
    return (
      <div className={cn(!flat && ROW)}>
        <SwitchRow
          label={field.label}
          help={description}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(c) => onChange(c)}
          {...(error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {})}
        />
        {error ? (
          <p id={`${id}-error`} className="mt-1 text-xs text-danger">
            {error}
          </p>
        ) : null}
        {details}
      </div>
    );
  }
  const helpId = description ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const help = description ? (
    <p id={helpId} className="text-xs text-fg-muted">
      {description}
      {inlineMeta ? <> {meta}</> : null}
    </p>
  ) : null;
  const control = (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1',
        // An inherited default reads as a value, not a disabled field.
        placeholder && '[&_input::placeholder]:text-fg',
        !flat && (field.kind === 'int' ? 'items-end' : 'md:items-end'),
      )}
    >
      <Control
        field={field}
        value={value}
        id={id}
        describedBy={errorId ?? helpId}
        invalid={Boolean(error)}
        placeholder={placeholder}
        disabled={disabled}
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
      <div className="flex max-w-md flex-col gap-2">
        <Label htmlFor={id}>{field.label}</Label>
        {control}
        {error ? null : help}
        {details}
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
        {details}
      </div>
      {control}
    </div>
  );
}
