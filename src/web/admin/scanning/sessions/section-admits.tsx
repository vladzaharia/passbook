import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  admitsOf,
  admitsWire,
  type ScanEventDto,
  ScanEventSchema,
} from '@/shared/contracts/scanners.ts';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { formatEventTime, formatTime } from '@/web/lib/format.ts';
import { Badge, Button, Callout } from '@/web/ui/index.ts';
import { localToIso } from '../../passes/schema-form/datetime.ts';
import { type EventDraft, newEvent } from '../setup/draft.ts';
import { EventForm } from '../setup/steps/event-form.tsx';
import { AdmitsPicker } from './admits-picker.tsx';
import { useUpdateSession } from './api.ts';
import { sessionAccepts } from './draft.ts';
import type { useSessionLive } from './session-live.ts';
import { RowEditor, SetupRow } from './setup-row.tsx';
import { useSectionEdit } from './use-section-edit.ts';

type Live = ReturnType<typeof useSessionLive>;

/** Create the event on the session's pass types, then admit it. */
function useAddEvent(s: ScanningSession, live: Live, onDone: () => void) {
  const client = useQueryClient();
  const update = useUpdateSession(s.id);
  return useMutation({
    mutationFn: async (e: EventDraft) => {
      const admits = s.accepts ? admitsOf(s.accepts) : { templateIds: [], eventIds: [] };
      const templateIds = admits.templateIds.length
        ? admits.templateIds
        : live.templates.map((t) => t.id);
      if (templateIds.length === 0) throw new Error('No approved pass types.');
      const at = (time: string) => Date.parse(localToIso(`${e.date}T${time}`, s.timeZone) ?? '');
      const made = await api.post('/api/v1/scan-events', ScanEventSchema, {
        orgId: s.orgId,
        name: e.name.trim(),
        templateIds,
        opensAt: at(e.opens),
        closesAt: at(e.closes),
        timeZone: s.timeZone,
        capacity: e.max.trim() ? Math.floor(Number(e.max)) : null,
        reentry: e.reentry,
      });
      await update.mutateAsync({
        accepts: admitsWire({ templateIds, eventIds: [...admits.eventIds, made.id] }),
        revision: s.updatedAt,
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'scanning'] });
      onDone();
    },
  });
}

function EventLine({ e, zone }: { e: ScanEventDto; zone: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 text-sm">
      <span className="font-medium text-fg-strong">{e.name}</span>
      <span className="text-fg-muted">
        {[
          `${formatEventTime(e.opensAt, zone)}–${formatTime(e.closesAt, zone)}`,
          e.capacity && `${e.capacity} max`,
          e.reentry && 'Re-entry',
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </li>
  );
}

/** Who gets in: pass types and events, edited in place; a new event is added inline. */
export function AdmitsRow({
  session: s,
  live,
  canManage,
}: {
  session: ScanningSession;
  live: Live;
  canManage: boolean;
}) {
  const [mode, setMode] = useState<'edit' | 'event'>();
  const done = () => setMode(undefined);
  const edit = useSectionEdit(s, done);
  const add = useAddEvent(s, live, done);
  const admits = s.accepts ? admitsOf(s.accepts) : { templateIds: [], eventIds: [] };
  const events = (live.events.data?.items ?? []).filter((e) => admits.eventIds.includes(e.id));
  const types = live.templates.filter((t) => admits.templateIds.includes(t.id));
  const actions =
    canManage && !mode ? (
      <>
        <Button
          variant="ghost"
          size="sm"
          iconStart={<Plus aria-hidden />}
          onClick={() => setMode('event')}
        >
          Add event
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconStart={<Pencil aria-hidden />}
          onClick={() => setMode('edit')}
        >
          Edit
        </Button>
      </>
    ) : undefined;
  return (
    <SetupRow label="Who gets in" actions={actions}>
      {mode === 'edit' ? (
        <RowEditor
          onSave={() => void edit.save()}
          onCancel={done}
          saving={edit.saving}
          disabled={!edit.ready}
          error={edit.error}
        >
          <AdmitsPicker
            orgId={s.orgId}
            any={edit.draft.accepts === 'all'}
            templateIds={edit.draft.templateIds}
            eventIds={edit.draft.eventIds}
            onAnyChange={(any) => edit.set({ accepts: any ? 'all' : 'templates' })}
            onChange={(patch) => edit.set(patch)}
          />
        </RowEditor>
      ) : (
        <div className="grid gap-2">
          {types.length || !s.accepts ? (
            <div className="flex flex-wrap gap-2">
              {s.accepts ? (
                types.map((t) => <Badge key={t.id}>{t.name}</Badge>)
              ) : (
                <span className="text-sm font-medium text-fg-strong">{sessionAccepts(s)}</span>
              )}
            </div>
          ) : null}
          {events.length ? (
            <ul className="grid gap-1">
              {events.map((e) => (
                <EventLine key={e.id} e={e} zone={e.timeZone} />
              ))}
            </ul>
          ) : null}
          {!types.length && s.accepts && !events.length ? (
            <span className="text-sm text-fg-muted">{sessionAccepts(s)}</span>
          ) : null}
        </div>
      )}
      {mode === 'event' ? (
        <div className="mt-3 grid gap-3">
          {add.isError ? <Callout tone="danger">{errorMessage(add.error)}</Callout> : null}
          <EventForm initial={newEvent()} onSave={(e) => add.mutate(e)} onCancel={done} />
        </div>
      ) : null}
    </SetupRow>
  );
}
