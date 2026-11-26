import type { ScanEventDto } from '@/shared/contracts/scanners.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import type { DateTimeValue } from '@/web/ui/date-time-field.tsx';
import { isoToLocal, localToIso } from '../../passes/schema-form/datetime.ts';

export const EVENT_STEPS = [
  { id: 'event', title: 'Event', heading: 'Name the event' },
  { id: 'passes', title: 'Passes', heading: 'Pick the passes' },
  { id: 'schedule', title: 'Schedule', heading: 'Set the hours' },
  { id: 'limits', title: 'Limits', heading: 'Set the limits' },
  { id: 'review', title: 'Review', heading: 'Check and create' },
] as const;
export type EventStepId = (typeof EVENT_STEPS)[number]['id'];

export const EVENT_HINTS: Partial<Record<EventStepId, string>> = {
  event: 'Name the event.',
  passes: 'Pick a template.',
  schedule: 'Set the hours.',
};

/** Where a server field error is fixed. */
export const EVENT_FIELD_STEP: Record<string, EventStepId> = {
  name: 'event',
  note: 'event',
  orgId: 'event',
  templateIds: 'passes',
  match: 'passes',
  opensAt: 'schedule',
  closesAt: 'schedule',
  timeZone: 'schedule',
  capacity: 'limits',
  hardLimit: 'limits',
  reentry: 'limits',
};

export interface EventDraft {
  name: string;
  templateIds: string[];
  opens: DateTimeValue | null;
  closes: DateTimeValue | null;
  capacity: string;
  hardLimit: boolean;
  note: string;
  reentry: boolean;
  matchInput: string;
  matchValues: string;
}

export function eventDraft(event?: ScanEventDto): EventDraft {
  const zone = event?.timeZone ?? DEFAULT_TIME_ZONE;
  const local = (ms: number | undefined) => ({
    local: ms === undefined ? '' : isoToLocal(new Date(ms).toISOString(), zone),
    zone,
  });
  return {
    name: event?.name ?? '',
    templateIds: event?.templateIds ?? [],
    opens: local(event?.opensAt),
    closes: local(event?.closesAt),
    capacity: event?.capacity?.toString() ?? '',
    hardLimit: event?.hardLimit ?? false,
    note: event?.note ?? '',
    reentry: event?.reentry ?? false,
    matchInput: event?.match?.input ?? '',
    matchValues: event?.match?.values.join(', ') ?? '',
  };
}

const at = (v: DateTimeValue | null, zone: string) =>
  Date.parse(localToIso(v?.local ?? '', v?.zone ?? zone) ?? '');

export function eventErrors(d: EventDraft, zone: string) {
  const opensAt = at(d.opens, zone);
  const closesAt = at(d.closes, zone);
  return {
    event: d.name.trim() ? undefined : { name: 'Enter a name.' },
    passes: !d.templateIds.length
      ? { templateIds: 'Pick at least one template.' }
      : d.matchInput.trim() && !d.matchValues.trim()
        ? { matchValues: 'Enter at least one matching value.' }
        : undefined,
    schedule: !d.opens?.local
      ? { opensAt: 'Set when scanning opens.' }
      : !d.closes?.local
        ? { closesAt: 'Set when scanning closes.' }
        : Number.isFinite(opensAt) && Number.isFinite(closesAt) && closesAt <= opensAt
          ? { closesAt: 'Closing must be after opening.' }
          : undefined,
  };
}

export function eventBody(d: EventDraft, orgId: string, zone: string) {
  const values = d.matchValues
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return {
    orgId,
    name: d.name,
    templateIds: d.templateIds,
    opensAt: at(d.opens, zone),
    closesAt: at(d.closes, zone),
    timeZone: d.opens?.zone ?? zone,
    capacity: d.capacity ? Number(d.capacity) : null,
    hardLimit: Boolean(d.capacity) && d.hardLimit,
    note: d.note.trim() || null,
    reentry: d.reentry,
    match: d.matchInput.trim() ? { input: d.matchInput.trim(), values } : null,
  };
}
