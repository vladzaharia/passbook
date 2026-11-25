import { useState } from 'react';
import type { ScanZone } from '@/shared/contracts/scan-access.ts';
import { toast, useWizard, WizardDialog, WizardReview } from '@/web/ui/index.ts';
import {
  createBody,
  emptyZoneDraft,
  ROOT,
  updateBody,
  type ZoneDraft,
  zoneDraft,
  zoneErrors,
} from './zone-draft.ts';
import { StepOccupancy, StepZone, zoneSummary } from './zone-steps.tsx';
import { useCreateZone, useUpdateZone } from './zones-api.ts';

interface Props {
  orgId: string;
  /** Every active zone: the Inside choices and the clock a child inherits. */
  zones: readonly ScanZone[];
  /** Edit this zone; absent creates one. */
  zone?: ScanZone;
  /** Create inside this zone. */
  parentId?: string;
  onClose: () => void;
}

const STEPS = [
  { id: 'zone', title: 'Zone', heading: 'Name the zone' },
  { id: 'occupancy', title: 'Occupancy', heading: 'Track who is inside' },
  { id: 'review', title: 'Review', heading: 'Check and create' },
] as const;
const HINTS = { zone: 'Name the zone.', occupancy: 'Fix the limits.' };
const FIELD_STEP = {
  name: 'zone',
  key: 'zone',
  parentId: 'zone',
  timeZone: 'zone',
  occupancy: 'occupancy',
  capacity: 'occupancy',
  hardLimit: 'occupancy',
  maxStayMinutes: 'occupancy',
  clearAt: 'occupancy',
} as const;

const keep = <K extends string>(all: Record<string, string | undefined>, keys: readonly K[]) =>
  Object.fromEntries(Object.entries(all).filter(([k]) => (keys as readonly string[]).includes(k)));

/**
 * A zone as a wizard (Zone, Occupancy, Review) or, with `zone`, its edit mode: every step open
 * from the rail, Save at the end. Stops its form events at the border so a picker inside another
 * form (a session's) never submits that form.
 */
export function ZoneDialog({ orgId, zones, zone, parentId, onClose }: Props) {
  const create = useCreateZone();
  const update = useUpdateZone(zone?.id ?? '');
  const [initial] = useState(() => (zone ? zoneDraft(zone) : emptyZoneDraft(parentId)));
  const [draft, setDraft] = useState<ZoneDraft>(initial);
  const parent = zones.find((z) => z.id === draft.parentId);
  const root = draft.parentId === ROOT;
  // Every org has a clock, so a root always has one.
  const clock = root ? true : Boolean(parent?.effectiveTimeZone ?? parent?.timeZone);
  const found = zoneErrors(draft, !zone, clock);
  const sections = zoneSummary(draft, zones, root);
  const summary = (id: 'zone' | 'occupancy') =>
    id === 'zone'
      ? draft.name.trim() || undefined
      : draft.track
        ? draft.enforce
          ? 'Tap out required'
          : 'Tracked'
        : 'Not tracked';
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const w = useWizard({
    open: true,
    mode: zone ? 'edit' : 'create',
    dirty,
    steps: STEPS.filter((s) => !zone || s.id !== 'review').map((s) => ({
      ...s,
      ...(s.id === 'review' ? {} : { summary: summary(s.id) }),
    })),
    errors: {
      zone: keep(found, ['name', 'key']),
      occupancy: keep(found, ['capacity', 'maxStay', 'clearAt']),
    },
    hints: HINTS,
    fieldStep: FIELD_STEP,
    onFinish: async () => {
      if (zone) await update.mutateAsync(updateBody(draft, zone));
      else await create.mutateAsync(createBody(draft, orgId));
      toast.success(zone ? 'Saved' : 'Zone created');
      onClose();
    },
  });
  const errors = { ...w.errors, maxStay: w.errors.maxStay ?? w.errors.maxStayMinutes };

  return (
    <div
      className="contents"
      onSubmit={(e) => e.stopPropagation()}
      onInput={(e) => e.stopPropagation()}
    >
      <WizardDialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={zone ? `Edit ${zone.name}` : parentId ? 'Add a zone inside' : 'New zone'}
        wizard={w}
        dirty={dirty}
        finishLabel={zone ? 'Save' : 'Create zone'}
        busy={create.isPending || update.isPending}
      >
        {w.id === 'zone' ? (
          <StepZone
            draft={draft}
            set={setDraft}
            zones={zones}
            zone={zone}
            root={root}
            errors={errors}
            onEdit={w.clearServer}
          />
        ) : null}
        {w.id === 'occupancy' ? (
          <StepOccupancy draft={draft} set={setDraft} zone={zone} errors={errors} />
        ) : null}
        {w.id === 'review' ? <WizardReview sections={sections} onEdit={w.go} /> : null}
      </WizardDialog>
    </div>
  );
}
