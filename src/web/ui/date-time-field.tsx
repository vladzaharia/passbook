import { useId, useMemo } from 'react';
import { cn } from '../lib/cn.ts';
import { formatWallTime } from '../lib/format.ts';
import { zoneLabel, zoneOptions } from '../lib/timezones.ts';
import { CheckboxField } from './checkbox.tsx';
import { Combobox } from './combobox.tsx';
import { CONTROL, CONTROL_HEIGHT } from './input.tsx';

export interface DateTimeValue {
  /** datetime-local value: "2026-11-15T04:08". */
  local: string;
  /** IANA zone id. */
  zone: string;
}

export interface DateTimeFieldProps {
  id?: string;
  value: DateTimeValue | null;
  onChange: (value: DateTimeValue | null) => void;
  /** "No date" or "Never expires": checked hides the controls and sets null. */
  clearLabel: string;
  /** Used when the clear box is unchecked. */
  defaultZone: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  className?: string;
}

/**
 * A styled native datetime-local plus a time zone combobox ("Los Angeles (PT)", stores the IANA
 * id), with the value spelled out below. Full width under 768. The clear box hides both.
 */
export function DateTimeField({
  id,
  value,
  onChange,
  clearLabel,
  defaultZone,
  className,
  ...aria
}: DateTimeFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const zones = useMemo(() => zoneOptions(), []);
  const shown = value?.local ? formatWallTime(value.local) : '';
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {value ? (
        <>
          <div className="flex flex-col gap-2 md:flex-row">
            <input
              id={inputId}
              type="datetime-local"
              value={value.local}
              onChange={(e) => onChange({ ...value, local: e.target.value })}
              className={cn(
                CONTROL,
                CONTROL_HEIGHT,
                'md:w-60 [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100 [&::-webkit-inner-spin-button]:hidden',
              )}
              {...aria}
            />
            <Combobox
              aria-label="Time zone"
              searchPlaceholder="Find a city"
              className="md:w-56"
              options={zones}
              value={value.zone}
              onValueChange={(zone) => onChange({ ...value, zone })}
            />
          </div>
          {shown ? (
            <p className="text-xs text-fg-muted">
              {shown}, {zoneLabel(value.zone)}
            </p>
          ) : null}
        </>
      ) : null}
      <CheckboxField
        label={clearLabel}
        checked={value === null}
        onCheckedChange={(checked) =>
          onChange(checked === true ? null : { local: '', zone: defaultZone })
        }
      />
    </div>
  );
}
