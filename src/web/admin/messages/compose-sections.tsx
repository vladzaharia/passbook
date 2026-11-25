import { useMemo } from 'react';
import type { z } from 'zod';
import { BROADCAST_MESSAGE_MAX } from '@/shared/contracts/broadcasts.ts';
import type { TemplateDetailSchema } from '@/shared/contracts/templates.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import { zoneLabel } from '../../lib/timezones.ts';
import {
  CheckboxField,
  DateTimeField,
  DependentSettings,
  FormField,
  SegmentedControl,
  Select,
  SwitchRow,
  Textarea,
} from '../../ui/index.ts';
import { type FormValues, SchemaForm } from '../passes/schema-form/index.ts';
import { commonFields } from './common-fields.ts';
import type { ComposerState } from './composer-state.ts';
import { CLEAR_CHOICES } from './labels.ts';
import { QuickMessages } from './quick-messages.tsx';

type TemplateDetailDto = z.infer<typeof TemplateDetailSchema>;
type Patch = (patch: Partial<ComposerState>) => void;

export function MessageSection({
  state,
  onChange,
  error,
}: {
  state: ComposerState;
  onChange: Patch;
  error?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      {state.clearing ? (
        <p className="text-sm text-fg-muted">
          Clears the message on the passes you reach. Holders are not notified.
        </p>
      ) : (
        <FormField
          label="Message"
          error={error}
          help={`${state.message.length} of ${BROADCAST_MESSAGE_MAX}`}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              maxLength={BROADCAST_MESSAGE_MAX}
              value={state.message}
              placeholder="Doors open at 7"
              onChange={(e) => onChange({ message: e.target.value })}
            />
          )}
        </FormField>
      )}
      {state.clearing ? null : (
        <QuickMessages value={state.message} onPick={(message) => onChange({ message })} />
      )}
      <CheckboxField
        label="Only clear the current message"
        checked={state.clearing}
        onCheckedChange={(on) => onChange({ clearing: on === true, clear: 'never' })}
      />
      <DependentSettings open={!state.clearing}>
        <SwitchRow
          label="Notify holders"
          checked={state.notify}
          onCheckedChange={(notify) => onChange({ notify })}
        />
        <FormField label="Expires">
          {(control) => (
            <Select
              {...control}
              options={CLEAR_CHOICES.map(({ value, label }) => ({ value, label }))}
              value={state.clear}
              onValueChange={(clear) => onChange({ clear })}
            />
          )}
        </FormField>
      </DependentSettings>
    </div>
  );
}

/** Inputs every chosen template has, with the first template's labels and widgets. */
function commonSchema(details: readonly TemplateDetailDto[], keys: readonly string[]) {
  const first = details[0]?.inputSchema as Record<string, unknown> | undefined;
  if (!first) return undefined;
  const props = (first.properties ?? {}) as Record<string, unknown>;
  const picked = Object.fromEntries(Object.entries(props).filter(([k]) => keys.includes(k)));
  return { ...first, properties: picked, required: [], dependentRequired: undefined };
}

export function ChangeSection({
  state,
  onChange,
  details,
  error,
}: {
  state: ComposerState;
  onChange: Patch;
  details: readonly TemplateDetailDto[];
  error?: string | undefined;
}) {
  const fields = useMemo(() => commonFields(details), [details]);
  const schema = commonSchema(details, state.fields);
  const toggle = (key: string, on: boolean) => {
    const next = on ? [...state.fields, key] : state.fields.filter((k) => k !== key);
    const values: FormValues = Object.fromEntries(
      Object.entries(state.values).filter(([k]) => next.includes(k)),
    );
    onChange({ fields: next, values });
  };
  if (details.length === 0)
    return <p className="text-sm text-fg-muted">Choose a template to pick what changes.</p>;
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="mb-2 text-sm font-medium text-fg-strong">What changes</legend>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {fields.map((f) => (
            <CheckboxField
              key={f.key}
              label={f.label}
              checked={state.fields.includes(f.key)}
              onCheckedChange={(on) => toggle(f.key, on === true)}
            />
          ))}
        </div>
        {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      </fieldset>
      {schema && state.fields.length > 0 ? (
        <SchemaForm
          schema={schema}
          value={state.values}
          onChange={(values) => onChange({ values })}
          idPrefix="change"
        />
      ) : null}
      <SwitchRow
        label="Notify holders"
        checked={state.notify}
        onCheckedChange={(notify) => onChange({ notify })}
      />
    </div>
  );
}

export function WhenSection({
  state,
  onChange,
  error,
}: {
  state: ComposerState;
  onChange: Patch;
  error?: string | undefined;
}) {
  const zone = state.at?.zone ?? DEFAULT_TIME_ZONE;
  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        label="When"
        options={[
          { value: 'now', label: 'Now' },
          { value: 'later', label: 'Schedule' },
        ]}
        value={state.when}
        onValueChange={(when) =>
          onChange({ when, at: when === 'later' ? (state.at ?? { local: '', zone }) : state.at })
        }
      />
      {state.when === 'later' ? (
        <FormField label="Send at" error={error} help={`Time zone: ${zoneLabel(zone)}`}>
          {(control) => (
            <DateTimeField
              id={control.id}
              aria-describedby={control['aria-describedby']}
              aria-invalid={control['aria-invalid']}
              value={state.at ?? { local: '', zone }}
              onChange={(value) => onChange({ at: value })}
              clearLabel="No time"
              defaultZone={zone}
            />
          )}
        </FormField>
      ) : null}
    </div>
  );
}

/** Text message or field change; switching clears what the other kind chose. */
export function KindControl({ state, onChange }: { state: ComposerState; onChange: Patch }) {
  return (
    <SegmentedControl
      label="Type"
      options={[
        { value: 'message', label: 'Text message' },
        { value: 'change', label: 'Field change' },
      ]}
      value={state.kind}
      onValueChange={(kind) =>
        onChange({ kind, templateIds: [], fields: [], values: {}, clearing: false })
      }
    />
  );
}
