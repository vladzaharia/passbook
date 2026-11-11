import type { CheckInPolicy } from '@/shared/contracts/check-in.ts';
import type { Mode } from '@/shared/contracts/common.ts';
import { useMode } from '@/web/lib/mode.ts';
import { localZone } from '@/web/lib/timezones.ts';
import { DateTimeField, FormField, NumberField, Select } from '@/web/ui/index.ts';
import { isoToLocal, localToIso } from '../passes/schema-form/datetime.ts';
import { useScanEvents } from './scanner-api.ts';

export function CheckInFields({
  rules,
  defaults = {},
  onChange,
  orgId,
  disabled = false,
  timeZone,
  resourceMode,
}: {
  rules: CheckInPolicy;
  defaults?: CheckInPolicy;
  onChange: (rules: CheckInPolicy) => void;
  orgId: string;
  disabled?: boolean;
  timeZone?: string;
  resourceMode?: Mode;
}) {
  const zone = timeZone ?? localZone();
  const mode = useMode();
  const events = useScanEvents(
    orgId || undefined,
    Boolean(orgId) && (!resourceMode || resourceMode === mode),
  );
  const set = (patch: Partial<CheckInPolicy>) => onChange({ ...rules, ...patch });
  const effective = { ...defaults, ...rules };
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-4 @[36rem]:grid-cols-2">
      <FormField label="Check-in type">
        {(p) => (
          <Select
            {...p}
            value={rules.mode ?? 'inherit'}
            onValueChange={(mode) => {
              const next = { ...rules };
              if (mode === 'inherit') delete next.mode;
              else next.mode = mode as CheckInPolicy['mode'];
              onChange(next);
            }}
            options={[
              { value: 'inherit', label: 'Use pass or template rules' },
              { value: 'single', label: 'One scan; no check-out' },
              { value: 'daily', label: 'Once per day' },
              { value: 'unlimited', label: 'Unlimited scans' },
              { value: 'in_out', label: 'Track in / out' },
            ]}
          />
        )}
      </FormField>
      <FormField label="Event restriction">
        {(p) => (
          <Select
            {...p}
            value={rules.eventId ?? 'none'}
            onValueChange={(id) => set({ eventId: id === 'none' ? null : id })}
            options={[
              { value: 'none', label: 'No additional event restriction' },
              ...(events.data?.items ?? [])
                .filter((event) => event.orgId === orgId)
                .map((event) => ({ value: event.id, label: event.name })),
            ]}
          />
        )}
      </FormField>
      {(['validFrom', 'validUntil'] as const).map((field) => (
        <FormField key={field} label={field === 'validFrom' ? 'Valid from' : 'Valid until'}>
          {(p) => (
            <DateTimeField
              {...p}
              defaultZone={zone}
              clearLabel={field === 'validFrom' ? 'No start date' : 'No end date'}
              value={
                effective[field] == null
                  ? null
                  : { local: isoToLocal(new Date(effective[field]).toISOString(), zone), zone }
              }
              onChange={(value) => {
                const iso = value ? localToIso(value.local, value.zone) : null;
                if (!value || iso) set({ [field]: iso ? Date.parse(iso) : null });
              }}
            />
          )}
        </FormField>
      ))}
      <FormField
        label="Duration in minutes"
        help="Optional. Measured from issue or the first successful scan."
      >
        {(p) => (
          <NumberField
            {...p}
            min={1}
            max={5_256_000}
            value={rules.durationMinutes ?? null}
            onValueChange={(durationMinutes) => set({ durationMinutes })}
          />
        )}
      </FormField>
      {rules.durationMinutes ? (
        <FormField label="Duration starts">
          {(p) => (
            <Select
              {...p}
              value={rules.durationFrom ?? 'first_scan'}
              onValueChange={(durationFrom) =>
                set({ durationFrom: durationFrom as CheckInPolicy['durationFrom'] })
              }
              options={[
                { value: 'first_scan', label: 'First successful scan' },
                { value: 'issued', label: 'Pass issued' },
              ]}
            />
          )}
        </FormField>
      ) : null}
    </fieldset>
  );
}
