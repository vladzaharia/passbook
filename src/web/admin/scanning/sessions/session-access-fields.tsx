import { ArrowLeftRight, LogIn, LogOut, ScanLine } from 'lucide-react';
import { Callout, OptionTile, SwitchRow } from '@/web/ui/index.ts';
import type { ScannerDraft } from '../scanners/scanner-draft.ts';
import { ZonePicker } from '../zones/zone-picker.tsx';
import { zoneNodes } from '../zones/zone-tree.ts';
import { useZones } from '../zones/zones-api.ts';
import type { SessionDraft } from './draft.ts';

const DIRECTIONS = [
  { value: 'pass', label: 'Pass rules', description: 'The pass decides.', icon: ScanLine },
  { value: 'in', label: 'In', description: 'Every scan taps in.', icon: LogIn },
  { value: 'out', label: 'Out', description: 'Every scan taps out.', icon: LogOut },
  {
    value: 'both',
    label: 'Both',
    description: 'Auto: in if they’re out, out if they’re in.',
    icon: ArrowLeftRight,
  },
] as const;

/** Checks, direction and Desk actions: what the session's doors do with a scan. */
export function SessionAccessFields({
  draft,
  set,
}: {
  draft: SessionDraft;
  set: (patch: Partial<SessionDraft>) => void;
}) {
  const zones = useZones(draft.orgId || undefined, false, Boolean(draft.orgId));
  const event = draft.accepts === 'event';
  const counted = zoneNodes(zones.data ?? []).find(
    (n) => draft.zoneIds?.includes(n.zone.id) && n.zone.occupancy !== 'off',
  )?.zone;
  const counts = counted
    ? `Counts people in ${counted.name}${counted.inNow === null ? '.' : ` · ${counted.inNow} inside now.`}`
    : undefined;
  return (
    <div className="grid gap-6">
      {draft.zoneIds ? (
        <ZonePicker
          orgId={draft.orgId}
          label="Checks"
          value={event ? [] : draft.zoneIds}
          disabled={event}
          help={
            event
              ? 'Events check in once. Zones don’t apply.'
              : 'Lets in a pass that opens either zone now. Empty: Any zone.'
          }
          onChange={(zoneIds) => set({ zoneIds })}
        />
      ) : null}
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium text-fg-strong">Direction</legend>
        <div className="grid gap-3 @[34rem]:grid-cols-2">
          {DIRECTIONS.map((d) => (
            <OptionTile
              key={d.value}
              name="session-direction"
              value={d.value}
              label={d.label}
              description={d.description}
              icon={d.icon}
              checked={draft.direction === d.value}
              onSelect={(direction) => set({ direction: direction as ScannerDraft['direction'] })}
            />
          ))}
        </div>
        <p className="text-xs text-fg-muted">
          A reader at a door: pick In or Out. One phone at the desk: Both.
          {counts ? ` ${counts}` : ''}
        </p>
      </fieldset>
      <section className="grid gap-3 border-t border-border pt-6">
        <SwitchRow
          label="Desk actions"
          help="Staff sign in here to let people in and mark them out. Guest limits ask for a Manager."
          checked={draft.deskActions}
          onCheckedChange={(deskActions) => set({ deskActions })}
        />
        {draft.deskActions ? (
          <Callout tone="info">
            Every action is signed by the staff member and shows in the pass’s activity.
          </Callout>
        ) : null}
      </section>
    </div>
  );
}
