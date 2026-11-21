import { CheckboxField, FormField, SegmentedControl, Select } from '@/web/ui/index.ts';
import { useScanEvents } from '../scanner-api.ts';
import { useScanningSessions } from '../sessions/api.ts';
import { ZonePicker } from '../zones/zone-picker.tsx';
import { type ScannerDraft, type WatchKind, watchKind } from './scanner-draft.ts';

const MAX = 8;

const KINDS: { value: WatchKind; label: string }[] = [
  { value: 'scanners', label: 'Scanners' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'event', label: 'Event' },
  { value: 'zones', label: 'Zones' },
];

/**
 * What a monitor watches: scanners, whole sessions, one event or zones. Customer screens follow
 * scanners and sessions only (they never show a place's crowd). The scanner list stays in
 * SetupFields; this owns the other three and the switch between them.
 */
export function WatchFields({
  draft,
  onChange,
  error,
}: {
  draft: ScannerDraft;
  onChange: (patch: Partial<ScannerDraft>) => void;
  error?: string | undefined;
}) {
  const monitor = draft.deviceRole === 'monitor';
  const kind = watchKind(draft.watch);
  const sessions = useScanningSessions(draft.orgId || undefined);
  const events = useScanEvents(draft.orgId || undefined, Boolean(draft.orgId) && kind === 'event');
  const pickKind = (next: WatchKind) =>
    onChange({
      watch: {
        scannerIds: [],
        allOrg: false,
        ...(next === 'sessions' ? { sessionIds: [] } : {}),
        ...(next === 'event' ? { eventId: '' } : {}),
        ...(next === 'zones' ? { zoneIds: [] } : {}),
      },
    });
  const picked = draft.watch.sessionIds ?? [];
  const allSessions = sessions.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="grid gap-4">
      <SegmentedControl
        label="Watch"
        value={kind}
        options={KINDS.filter((k) => monitor || k.value === 'scanners' || k.value === 'sessions')}
        onValueChange={pickKind}
        block
      />
      {kind === 'sessions' ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Sessions</legend>
          <p className="text-xs text-fg-muted">
            {picked.length} of {MAX}.
          </p>
          {allSessions
            .filter((s) => s.orgId === draft.orgId && s.status !== 'ended')
            .map((s) => (
              <CheckboxField
                key={s.id}
                label={s.name}
                checked={picked.includes(s.id)}
                disabled={picked.length >= MAX && !picked.includes(s.id)}
                onCheckedChange={(on) =>
                  onChange({
                    watch: {
                      ...draft.watch,
                      sessionIds: on ? [...picked, s.id] : picked.filter((id) => id !== s.id),
                    },
                  })
                }
              />
            ))}
          {!sessions.isPending && allSessions.length === 0 ? (
            <p className="text-sm text-fg-muted">Create a session first.</p>
          ) : null}
        </fieldset>
      ) : null}
      {kind === 'event' ? (
        <FormField label="Event" required>
          {(p) => (
            <Select
              {...p}
              value={draft.watch.eventId || undefined}
              placeholder="Pick an event"
              options={(events.data?.items ?? [])
                .filter((e) => e.orgId === draft.orgId)
                .map((e) => ({ value: e.id, label: e.name }))}
              onValueChange={(eventId) => onChange({ watch: { ...draft.watch, eventId } })}
            />
          )}
        </FormField>
      ) : null}
      {kind === 'zones' ? (
        <ZonePicker
          orgId={draft.orgId}
          label="Zones"
          help="Every scan in these zones, at any door that checks them."
          value={draft.watch.zoneIds ?? []}
          onChange={(zoneIds) => onChange({ watch: { ...draft.watch, zoneIds } })}
        />
      ) : null}
      {kind !== 'scanners' && error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
