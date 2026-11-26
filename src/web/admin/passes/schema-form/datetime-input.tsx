import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { cn } from '../../../lib/cn.ts';
import { formatWallTime } from '../../../lib/format.ts';
import { zoneLabel, zoneOptions } from '../../../lib/timezones.ts';
import { CheckboxField, CONTROL, CONTROL_HEIGHT, Combobox } from '../../../ui/index.ts';
import { isoToLocal, localToOffsetIso, writtenOffset, zoneOffset } from './datetime.ts';

interface Props {
  value: string;
  onValue: (v: string | undefined) => void;
  disabled?: boolean | undefined;
  onBlur: () => void;
  /** Optional fields: "No date" or "Never expires" hides the controls and clears the value. */
  clearLabel?: string | undefined;
  /** The venue zone from the template's time zone input: values show in it. */
  zone?: string | undefined;
  /** The org's zone: the editor's zone when there is no venue zone and no written offset. */
  orgZone?: string | undefined;
  [key: string]: unknown;
}

/**
 * The zone a stored value is read in: its written offset when it has one the org zone does not
 * match, else the org's. A `Z` is how it was stored, not a zone choice.
 */
function zoneFor(iso: string, orgZone: string): string {
  const ms = Date.parse(iso);
  const written = /Z$/i.test(iso) ? undefined : writtenOffset(iso);
  if (Number.isNaN(ms) || written === undefined || zoneOffset(ms, orgZone) === written) {
    return orgZone;
  }
  return zoneOptions().find((z) => zoneOffset(ms, z.value) === written)?.value ?? orgZone;
}

/**
 * A date and time in a named zone ("Los Angeles (PT)"). Stores ISO with that zone's offset, so
 * the pass shows local time; the value is spelled out below.
 */
export function DateTimeInput({
  value,
  onValue,
  disabled,
  onBlur,
  clearLabel,
  zone: venueZone,
  orgZone = DEFAULT_TIME_ZONE,
  ...control
}: Props) {
  const [zone, setZone] = useState(() => venueZone ?? (value ? zoneFor(value, orgZone) : orgZone));
  // The signed pass shows times in the venue zone, so the editor follows it.
  useEffect(() => {
    if (venueZone) setZone(venueZone);
  }, [venueZone]);
  const zones = useMemo(() => zoneOptions(), []);
  const [draft, setDraft] = useState<string>();
  const [none, setNone] = useState(value === '' && clearLabel !== undefined);
  const shown = draft ?? (value ? isoToLocal(value, zone) : '');
  const commit = (local: string, z: string) =>
    onValue(local ? localToOffsetIso(local, z) : undefined);
  return (
    <div className="flex flex-col gap-2">
      {none ? null : (
        <>
          {/* Wraps rather than widening a narrow column (the designer's Relevance pane). */}
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
            <input
              {...control}
              type="datetime-local"
              disabled={disabled}
              value={shown}
              onBlur={() => {
                setDraft(undefined);
                onBlur();
              }}
              onChange={(e) => {
                setDraft(e.target.value);
                commit(e.target.value, zone);
              }}
              className={cn(CONTROL, CONTROL_HEIGHT, 'md:w-60')}
            />
            <Combobox
              aria-label="Time zone"
              searchPlaceholder="Find a city"
              className="md:w-56"
              disabled={disabled}
              options={zones}
              value={zone}
              onValueChange={(z) => {
                setZone(z);
                if (shown) commit(shown, z);
              }}
            />
          </div>
          {shown ? (
            <p className="text-xs text-fg-muted">
              {formatWallTime(shown)}, {zoneLabel(zone)}
            </p>
          ) : null}
        </>
      )}
      {clearLabel ? (
        <CheckboxField
          label={clearLabel}
          checked={none}
          disabled={disabled}
          onCheckedChange={(c) => {
            setNone(c === true);
            if (c === true) onValue(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
