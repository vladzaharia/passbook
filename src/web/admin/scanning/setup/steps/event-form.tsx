import { useState } from 'react';
import { Button, FormField, FormGrid, Input, NumberField, SwitchRow } from '@/web/ui/index.ts';
import { type EventDraft, eventProblem } from '../draft.ts';

/** One event, added or edited in place: name, date, opens, closes, max, re-entry. */
export function EventForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: EventDraft;
  onSave: (event: EventDraft) => void;
  onCancel: () => void;
}) {
  const [e, setE] = useState(initial);
  const patch = (p: Partial<EventDraft>) => setE({ ...e, ...p });
  const problem = eventProblem(e);
  return (
    <div className="grid gap-4 rounded-lg border border-border-strong bg-surface-raised p-4">
      <FormGrid className="@[40rem]:grid-cols-2 @[64rem]:grid-cols-2">
        <FormField label="Name" required className="@[40rem]:col-span-2">
          {(c) => (
            <Input
              {...c}
              value={e.name}
              maxLength={80}
              onChange={(x) => patch({ name: x.target.value })}
            />
          )}
        </FormField>
        <FormField label="Date" required>
          {(c) => (
            <Input
              {...c}
              type="date"
              value={e.date}
              onChange={(x) => patch({ date: x.target.value })}
            />
          )}
        </FormField>

        <FormField label="Opens" required>
          {(c) => (
            <Input
              {...c}
              type="time"
              value={e.opens}
              onChange={(x) => patch({ opens: x.target.value })}
            />
          )}
        </FormField>
        <FormField label="Closes" required>
          {(c) => (
            <Input
              {...c}
              type="time"
              value={e.closes}
              onChange={(x) => patch({ closes: x.target.value })}
            />
          )}
        </FormField>
        <FormField label="Max">
          {(c) => (
            <NumberField
              {...c}
              min={1}
              className="w-full"
              value={e.max === '' ? null : Number(e.max)}
              onValueChange={(v) => patch({ max: v === null ? '' : String(v) })}
            />
          )}
        </FormField>
      </FormGrid>
      <SwitchRow
        label="Re-entry"
        checked={e.reentry}
        onCheckedChange={(reentry) => patch({ reentry })}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {problem ? <span className="mr-auto text-xs text-fg-muted">{problem}</span> : null}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={Boolean(problem)} onClick={() => onSave(e)}>
          Save event
        </Button>
      </div>
    </div>
  );
}
