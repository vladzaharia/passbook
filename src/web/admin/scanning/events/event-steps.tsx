import { formatWallTime } from '@/web/lib/format.ts';
import { zoneLabel } from '@/web/lib/timezones.ts';
import { CheckboxField } from '@/web/ui/checkbox.tsx';
import type { DateTimeValue } from '@/web/ui/date-time-field.tsx';
import { DateTimeField } from '@/web/ui/date-time-field.tsx';
import { FormField, Input, SwitchRow, WizardReview } from '@/web/ui/index.ts';
import { EligibleTemplatePicker } from '../eligible-template-picker.tsx';
import type { EventDraft, EventStepId } from './event-draft.ts';

type Errors = Record<string, string | undefined>;

interface StepProps {
  draft: EventDraft;
  set: (patch: Partial<EventDraft>) => void;
  errors: Errors;
  clear: (field?: string) => void;
}

export function StepEvent({ draft, set, errors }: StepProps) {
  return (
    <>
      <FormField label="Name" required error={errors.name}>
        {(p) => (
          <Input
            {...p}
            data-autofocus
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            required
            maxLength={80}
          />
        )}
      </FormField>
      <FormField
        label="Note for staff"
        help="Shown at the start and on heads-up and refused results."
        error={errors.note}
      >
        {(p) => (
          <Input
            {...p}
            maxLength={140}
            value={draft.note}
            onChange={(e) => set({ note: e.target.value })}
          />
        )}
      </FormField>
      <p className="-mt-3 text-right text-xs text-fg-muted">{draft.note.length}/140</p>
    </>
  );
}

export function StepPasses({ orgId, draft, set, errors, clear }: StepProps & { orgId: string }) {
  return (
    <>
      <EligibleTemplatePicker
        orgId={orgId}
        selected={draft.templateIds}
        onChange={(templateIds) => {
          clear('templateIds');
          set({ templateIds });
        }}
        requireCheckIn
        error={errors.templateIds}
        errorId="event-templates-error"
      />
      <div className="grid gap-3 @md:grid-cols-2">
        <FormField label="Only passes where" help="Input name; optional" error={errors.match}>
          {(p) => (
            <Input
              {...p}
              value={draft.matchInput}
              onChange={(e) => set({ matchInput: e.target.value })}
              maxLength={64}
            />
          )}
        </FormField>
        <FormField label="Equals" help="Values separated by commas" error={errors.matchValues}>
          {(p) => (
            <Input
              {...p}
              value={draft.matchValues}
              onChange={(e) => set({ matchValues: e.target.value })}
            />
          )}
        </FormField>
      </div>
      <p className="text-xs text-fg-muted">Leave empty to admit every pass of these templates.</p>
    </>
  );
}

export function StepSchedule({ zone, draft, set, errors, clear }: StepProps & { zone: string }) {
  const change = (key: 'opens' | 'closes', field: string) => (value: DateTimeValue | null) => {
    clear(field);
    if (key === 'opens' && value && draft.closes) {
      set({ opens: value, closes: { ...draft.closes, zone: value.zone } });
    } else set({ [key]: value });
  };
  return (
    <>
      <FormField label="Scanning opens" required error={errors.opensAt}>
        {(p) => (
          <DateTimeField
            {...p}
            value={draft.opens}
            onChange={change('opens', 'opensAt')}
            defaultZone={zone}
          />
        )}
      </FormField>
      <FormField label="Scanning closes" required error={errors.closesAt}>
        {(p) => (
          <DateTimeField
            {...p}
            value={draft.closes}
            onChange={change('closes', 'closesAt')}
            defaultZone={zone}
          />
        )}
      </FormField>
    </>
  );
}

export function StepLimits({ draft, set, errors, clear }: StepProps) {
  return (
    <>
      <FormField label="Capacity" help="Optional" error={errors.capacity}>
        {(p) => (
          <Input
            {...p}
            type="number"
            min={1}
            value={draft.capacity}
            onChange={(e) => set({ capacity: e.target.value })}
          />
        )}
      </FormField>
      <SwitchRow
        label="Hard limit"
        help="Full is final: no one can let anyone in. Needs a capacity."
        checked={Boolean(draft.capacity) && draft.hardLimit}
        disabled={!draft.capacity}
        onCheckedChange={(hardLimit) => {
          clear('hardLimit');
          set({ hardLimit });
        }}
      />
      <CheckboxField
        label="Allow re-entry"
        checked={draft.reentry}
        onCheckedChange={(value) => set({ reentry: value === true })}
      />
    </>
  );
}

const when = (v: DateTimeValue | null) =>
  v?.local ? `${formatWallTime(v.local)}, ${zoneLabel(v.zone)}` : 'Not set';

export function EventReview({
  draft,
  onEdit,
}: {
  draft: EventDraft;
  onEdit: (id: EventStepId) => void;
}) {
  const n = draft.templateIds.length;
  return (
    <WizardReview<EventStepId>
      onEdit={onEdit}
      sections={[
        {
          id: 'event',
          title: 'Event',
          items: [
            { label: 'Name', value: draft.name.trim() },
            ...(draft.note.trim() ? [{ label: 'Note', value: draft.note.trim() }] : []),
          ],
        },
        {
          id: 'passes',
          title: 'Passes',
          items: [
            { label: 'Templates', value: `${n} ${n === 1 ? 'template' : 'templates'}` },
            ...(draft.matchInput.trim()
              ? [
                  {
                    label: 'Only passes where',
                    value: `${draft.matchInput.trim()} = ${draft.matchValues.trim()}`,
                  },
                ]
              : []),
          ],
        },
        {
          id: 'schedule',
          title: 'Schedule',
          items: [
            { label: 'Opens', value: when(draft.opens) },
            { label: 'Closes', value: when(draft.closes) },
          ],
        },
        {
          id: 'limits',
          title: 'Limits',
          items: [
            {
              label: 'Capacity',
              value: draft.capacity
                ? `${draft.capacity}${draft.hardLimit ? ', hard limit' : ''}`
                : 'No limit',
            },
            { label: 'Re-entry', value: draft.reentry ? 'Allowed' : 'Not allowed' },
          ],
        },
      ]}
    />
  );
}
