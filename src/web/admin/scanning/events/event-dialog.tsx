import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ScanEventDto, ScanEventSchema } from '@/shared/contracts/scanners.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { useSeededZone } from '@/web/admin/settings/use-org-time-zone.ts';
import { api } from '@/web/lib/api.ts';
import { useWizard, WizardDialog } from '@/web/ui/index.ts';
import {
  EVENT_FIELD_STEP,
  EVENT_HINTS,
  EVENT_STEPS,
  type EventDraft,
  eventBody,
  eventDraft,
  eventErrors,
} from './event-draft.ts';
import { EventReview, StepEvent, StepLimits, StepPasses, StepSchedule } from './event-steps.tsx';

export function EventDialog({
  orgId,
  event,
  onClose,
}: {
  orgId: string;
  event?: ScanEventDto;
  onClose: () => void;
}) {
  const zone = event?.timeZone ?? DEFAULT_TIME_ZONE;
  const client = useQueryClient();
  const edit = Boolean(event);
  const [initial] = useState(() => JSON.stringify(eventDraft(event)));
  const [draft, setDraft] = useState<EventDraft>(() => eventDraft(event));
  const set = (patch: Partial<EventDraft>) => setDraft((d) => ({ ...d, ...patch }));
  useSeededZone(event ? undefined : orgId, (from, to) => {
    const move = (v: EventDraft['opens']) => (v && v.zone === from ? { ...v, zone: to } : v);
    setDraft((d) => ({ ...d, opens: move(d.opens), closes: move(d.closes) }));
  });
  const found = eventErrors(draft, zone);
  const dirty = JSON.stringify(draft) !== initial;
  const save = useMutation({
    mutationFn: async () => {
      const body = eventBody(draft, orgId, zone);
      if (event) {
        await api.action('PATCH', `/api/v1/scan-events/${encodeURIComponent(event.id)}`, body);
        return;
      }
      await api.post('/api/v1/scan-events', ScanEventSchema, body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'scanning', 'events'] });
      onClose();
    },
  });
  const n = draft.templateIds.length;
  const summary = {
    event: draft.name.trim() || undefined,
    passes: n ? `${n} ${n === 1 ? 'template' : 'templates'}` : undefined,
    limits: draft.capacity ? `${draft.capacity} capacity` : 'No limit',
  };
  const w = useWizard({
    open: true,
    mode: edit ? 'edit' : 'create',
    dirty,
    steps: EVENT_STEPS.filter((s) => !edit || s.id !== 'review').map((s) => ({
      ...s,
      summary: summary[s.id as keyof typeof summary],
    })),
    errors: found,
    hints: EVENT_HINTS,
    fieldStep: EVENT_FIELD_STEP,
    onFinish: () => save.mutateAsync(),
  });
  const step = { draft, set, errors: w.errors, clear: w.clearServer };
  return (
    <WizardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={edit ? 'Edit event' : 'New event'}
      wizard={w}
      dirty={dirty}
      finishLabel={edit ? 'Save' : 'Create event'}
      busy={save.isPending}
    >
      {w.id === 'event' ? <StepEvent {...step} /> : null}
      {w.id === 'passes' ? <StepPasses {...step} orgId={orgId} /> : null}
      {w.id === 'schedule' ? <StepSchedule {...step} zone={zone} /> : null}
      {w.id === 'limits' ? <StepLimits {...step} /> : null}
      {w.id === 'review' ? <EventReview draft={draft} onEdit={w.go} /> : null}
    </WizardDialog>
  );
}
