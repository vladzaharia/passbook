import type { ScanZone } from '@/shared/contracts/scan-access.ts';
import { formatCount } from '@/web/lib/format.ts';
import { zoneOptions } from '@/web/lib/timezones.ts';
import { FormField, Input, Select, type WizardReviewSection } from '@/web/ui/index.ts';
import { OccupancyFields } from './occupancy-fields.tsx';
import { ROOT, SESSION_CLOCK, withName, type ZoneDraft } from './zone-draft.ts';
import { MAX_DEPTH, zoneNodes } from './zone-tree.ts';

type Errors = Record<string, string | undefined>;
type SetDraft = (next: ZoneDraft) => void;

/** Zones a zone may sit inside: not itself or below it, and with room for what hangs under it. */
function parentOptions(zones: readonly ScanZone[], zone: ScanZone | undefined) {
  const nodes = zoneNodes(zones);
  const own = zone ? nodes.findIndex((n) => n.zone.id === zone.id) : -1;
  const self = own >= 0 ? nodes[own] : undefined;
  let height = 0;
  const blocked = new Set<string>(zone ? [zone.id] : []);
  if (self) {
    for (const n of nodes.slice(own + 1)) {
      if (n.level <= self.level) break;
      blocked.add(n.zone.id);
      height = Math.max(height, n.level - self.level);
    }
  }
  return nodes
    .filter((n) => !blocked.has(n.zone.id))
    .map((n) => ({
      value: n.zone.id,
      label: `${'– '.repeat(n.level - 1)}${n.zone.name}`,
      disabled: n.level + height > MAX_DEPTH,
    }));
}

/** Name, key, where it sits and, for a top zone, its clock. */
export function StepZone({
  draft,
  set,
  zones,
  zone,
  root,
  errors,
  onEdit,
}: {
  draft: ZoneDraft;
  set: SetDraft;
  zones: readonly ScanZone[];
  zone: ScanZone | undefined;
  root: boolean;
  errors: Errors;
  onEdit: (field: string) => void;
}) {
  return (
    <>
      <FormField label="Name" required error={errors.name}>
        {(p) => (
          <Input
            {...p}
            data-autofocus
            autoComplete="off"
            maxLength={40}
            placeholder="Pool"
            value={draft.name}
            onChange={(e) => set(withName(draft, e.target.value))}
          />
        )}
      </FormField>
      <FormField
        label="Key"
        required={!zone}
        error={errors.key}
        help={zone ? 'Cannot change.' : undefined}
      >
        {(p) => (
          <Input
            {...p}
            className="font-mono"
            autoComplete="off"
            maxLength={40}
            readOnly={!!zone}
            value={draft.key}
            onChange={(e) => set({ ...draft, key: e.target.value, keyEdited: true })}
          />
        )}
      </FormField>
      <FormField label="Inside" error={errors.parentId}>
        {(p) => (
          <Select
            {...p}
            value={draft.parentId}
            options={[{ value: ROOT, label: 'None' }, ...parentOptions(zones, zone)]}
            onValueChange={(parentId) => {
              onEdit('parentId');
              set({ ...draft, parentId });
            }}
          />
        )}
      </FormField>
      {root ? (
        <FormField label="Time zone" error={errors.timeZone}>
          {(p) => (
            <Select
              {...p}
              value={draft.timeZone}
              options={[{ value: SESSION_CLOCK, label: 'Organization’s clock' }, ...zoneOptions()]}
              onValueChange={(timeZone) => {
                onEdit('timeZone');
                set({ ...draft, timeZone });
              }}
            />
          )}
        </FormField>
      ) : null}
    </>
  );
}

/** Tracking and the limits that need it. */
export function StepOccupancy({
  draft,
  set,
  zone,
  errors,
}: {
  draft: ZoneDraft;
  set: SetDraft;
  zone: ScanZone | undefined;
  errors: Errors;
}) {
  return <OccupancyFields draft={draft} set={set} errors={errors} inNow={zone?.inNow ?? null} />;
}

const minutes = (n: number) => `${n} min`;

/** What the zone will be, by step. */
export function zoneSummary(
  draft: ZoneDraft,
  zones: readonly ScanZone[],
  root: boolean,
): WizardReviewSection<'zone' | 'occupancy'>[] {
  const parent = zones.find((z) => z.id === draft.parentId)?.name;
  const clock = zoneOptions().find((o) => o.value === draft.timeZone)?.label;
  return [
    {
      id: 'zone',
      title: 'Zone',
      items: [
        { label: 'Name', value: draft.name.trim() },
        { label: 'Key', value: draft.key, mono: true },
        { label: 'Inside', value: root ? 'None' : parent },
        ...(root
          ? [
              {
                label: 'Time zone',
                value: draft.timeZone === SESSION_CLOCK ? 'Organization’s clock' : clock,
              },
            ]
          : []),
      ],
    },
    {
      id: 'occupancy',
      title: 'Occupancy',
      items: draft.track
        ? [
            { label: 'Tracking', value: draft.enforce ? 'On, tap out required' : 'On' },
            {
              label: 'Capacity',
              value: draft.capacity === null ? undefined : formatCount(draft.capacity),
            },
            { label: 'Hard limit', value: draft.hardLimit ? 'On' : 'Off' },
            {
              label: 'Max stay',
              value: draft.maxStayMinutes === null ? undefined : minutes(draft.maxStayMinutes),
            },
            { label: 'Clear at', value: draft.clearAt || undefined },
          ]
        : [{ label: 'Tracking', value: 'Off' }],
    },
  ];
}
