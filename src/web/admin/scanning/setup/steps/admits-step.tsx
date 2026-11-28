import { Pencil, Plus, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { formatCalendarDate } from '@/web/lib/format.ts';
import { Button, CheckboxField, DependentSettings, IconButton, SwitchRow } from '@/web/ui/index.ts';
import { type EventDraft, newEvent } from '../draft.ts';
import { EventForm } from './event-form.tsx';
import type { StepProps } from './step-props.ts';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const toggle = (list: readonly string[], id: string, on: boolean) =>
  on ? [...list, id] : list.filter((x) => x !== id);

function EventRow({
  event,
  onEdit,
  onRemove,
}: {
  event: EventDraft;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [, m, d] = event.date.split('-');
  const month = MONTHS[Number(m) - 1] ?? '';
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-surface-raised p-3">
      <span
        aria-hidden
        className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-sunken text-center leading-none"
      >
        <span className="text-xs font-semibold text-danger">{month}</span>
        <span className="text-base font-semibold text-fg-strong tabular-nums">
          {d ? Number(d) : ''}
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg-strong">{event.name}</p>
        <p className="text-xs text-fg-muted">
          {[
            event.date && formatCalendarDate(event.date),
            `${event.opens}–${event.closes}`,
            event.max && `${event.max} max`,
            event.reentry && 'Re-entry',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        iconStart={<Pencil aria-hidden />}
        aria-label={`Edit ${event.name}`}
        onClick={onEdit}
      >
        Edit
      </Button>
      <IconButton label={`Remove ${event.name}`} icon={<X aria-hidden />} onClick={onRemove} />
    </li>
  );
}

/** Pass types, then the events the door admits. A new event is added inline. */
export function AdmitsStep({ draft, set, ctx }: StepProps) {
  // `new` adds; a ref edits that event; undefined is closed.
  const [form, setForm] = useState<'new' | string>();
  const saveEvent = (e: EventDraft) => {
    const exists = draft.events.some((x) => x.ref === e.ref);
    set({
      events: exists ? draft.events.map((x) => (x.ref === e.ref ? e : x)) : [...draft.events, e],
    });
    setForm(undefined);
  };
  const editing = draft.events.find((e) => e.ref === form);
  const liveEvents = ctx.events;
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 rounded-lg border border-border bg-surface-raised p-4">
        <SwitchRow
          label="Any pass type"
          checked={draft.any}
          onCheckedChange={(any) => set({ any })}
        />
        <DependentSettings open={!draft.any}>
          {ctx.templates.length === 0 ? (
            <p className="text-sm text-fg-muted">No approved pass types.</p>
          ) : (
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Pass types</legend>
              {ctx.templates.map((t) => (
                <div
                  key={t.id}
                  className="rounded-lg border border-border-strong px-3 py-1 has-[[data-state=checked]]:border-accent has-[[data-state=checked]]:bg-accent-subtle"
                >
                  <CheckboxField
                    label={t.name}
                    checked={draft.templateIds.includes(t.id)}
                    onCheckedChange={(on) =>
                      set({ templateIds: toggle(draft.templateIds, t.id, on === true) })
                    }
                  />
                </div>
              ))}
            </fieldset>
          )}
        </DependentSettings>
      </div>
      <section aria-label="Events" className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-fg-strong">Events</h3>
          {draft.fromTemplate ? (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={draft.fromIssued}
              iconStart={<Sparkles aria-hidden />}
              onClick={() => set({ fromIssued: !draft.fromIssued })}
            >
              From issued passes
            </Button>
          ) : null}
        </div>
        {draft.events.length + liveEvents.length > 0 ? (
          <ul className="grid gap-2">
            {draft.events.map((e) =>
              form === e.ref ? null : (
                <EventRow
                  key={e.ref}
                  event={e}
                  onEdit={() => setForm(e.ref)}
                  onRemove={() => set({ events: draft.events.filter((x) => x.ref !== e.ref) })}
                />
              ),
            )}
            {liveEvents.map((e) => (
              <li
                key={e.id}
                className="rounded-lg border border-border bg-surface-raised px-3 py-1"
              >
                <CheckboxField
                  label={e.name}
                  checked={draft.eventIds.includes(e.id)}
                  onCheckedChange={(on) =>
                    set({ eventIds: toggle(draft.eventIds, e.id, on === true) })
                  }
                />
              </li>
            ))}
          </ul>
        ) : null}
        {form === 'new' || editing ? (
          <EventForm
            key={form}
            initial={editing ?? newEvent()}
            onSave={saveEvent}
            onCancel={() => setForm(undefined)}
          />
        ) : (
          <div>
            <Button
              variant="outline"
              size="sm"
              iconStart={<Plus aria-hidden />}
              onClick={() => setForm('new')}
            >
              Add event
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
