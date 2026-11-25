import { BROADCAST_MESSAGE_MAX } from '@/shared/contracts/broadcasts.ts';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { ruleSummary } from '@/shared/copy/message-rules.ts';
import { localZone, zoneLabel } from '../../lib/timezones.ts';
import {
  FormField,
  Input,
  Select,
  Textarea,
  WizardReview,
  type WizardReviewSection,
} from '../../ui/index.ts';
import type { FieldDef } from '../passes/schema-form/index.ts';
import { CLEAR_CHOICES } from './labels.ts';
import { LockScreenNotice } from './lock-screen.tsx';
import { MatchEditor } from './match-editor.tsx';
import { QuickMessages } from './quick-messages.tsx';
import { RulePreview } from './rule-preview.tsx';
import { keyLabel, LAST_SCAN, type RuleField, type RuleState } from './rule-state.ts';
import { TemplateChoices } from './template-choices.tsx';

export const RULE_STEPS = [
  { id: 'passes', title: 'Passes', heading: 'Pick the passes' },
  { id: 'when', title: 'When', heading: 'Set when it sends' },
  { id: 'message', title: 'Message', heading: 'Write the message' },
  { id: 'review', title: 'Review', heading: 'Check who is due' },
] as const;
export type RuleStepId = (typeof RULE_STEPS)[number]['id'];

export const RULE_HINTS: Partial<Record<RuleStepId, string>> = {
  passes: 'Name it, pick passes.',
  when: 'Set the timing.',
  message: 'Write a message.',
};

/** Where a server field is fixed. */
export const RULE_FIELD_STEP: Record<string, RuleStepId> = {
  name: 'passes',
  templateIds: 'passes',
  match: 'passes',
  anchor: 'when',
  offset: 'when',
  yearly: 'when',
  sendAt: 'when',
  timeZone: 'when',
  message: 'message',
  clearAfter: 'message',
};

type Errors = Partial<Record<RuleField, string>>;

/** The draft's problems, grouped by the step that fixes them. */
export function stepErrors(errors: Errors): Partial<Record<RuleStepId, Errors>> {
  const pick = (...keys: RuleField[]) => {
    const found: Errors = {};
    for (const k of keys) if (errors[k]) found[k] = errors[k];
    return Object.keys(found).length ? found : undefined;
  };
  return {
    passes: pick('name', 'templates', 'match'),
    when: pick('anchor', 'offset', 'sendAt', 'yearly'),
    message: pick('message'),
  };
}

export function whenSummary(state: RuleState, fields: readonly FieldDef[]): string | undefined {
  if (!state.anchor || state.amount === null) return undefined;
  return ruleSummary({
    anchorLabel:
      state.anchor === LAST_SCAN
        ? 'the last scan'
        : (fields.find((f) => f.key === state.anchor)?.label ?? keyLabel(state.anchor)),
    offset: { amount: state.amount, unit: state.unit, when: state.when },
    yearly: state.yearly,
    sendAt: state.sendAt,
  });
}

type Patch = (patch: Partial<RuleState>) => void;
type ErrorMap = Record<string, string | undefined>;

export function StepPasses({
  orgId,
  state,
  change,
  fields,
  errors,
  templates,
  loading,
  details,
  onToggle,
}: {
  orgId: string;
  state: RuleState;
  change: Patch;
  fields: readonly FieldDef[];
  errors: ErrorMap;
  templates: readonly TemplateSummaryDto[];
  loading: boolean;
  details: ReadonlyMap<string, { manifest: unknown }>;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormField label="Name" required error={errors.name}>
        {(c) => (
          <Input
            {...c}
            data-autofocus
            maxLength={80}
            value={state.name}
            onChange={(e) => change({ name: e.target.value })}
          />
        )}
      </FormField>
      <TemplateChoices
        orgId={orgId}
        templates={templates}
        loading={loading}
        details={details}
        chosen={state.templateIds}
        needsMessage
        onToggle={onToggle}
        error={errors.templates ?? errors.templateIds}
      />
      <MatchEditor
        fields={fields}
        value={state.match}
        onChange={(match) => change({ match })}
        error={errors.match}
      />
    </div>
  );
}

export function StepMessage({
  state,
  change,
  errors,
  org,
}: {
  state: RuleState;
  change: Patch;
  errors: ErrorMap;
  org: { id: string; name: string; accent: string | null } | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormField
        label="Text"
        required
        error={errors.message}
        help={`${state.message.length} of ${BROADCAST_MESSAGE_MAX}. Keep private details out.`}
      >
        {(c) => (
          <Textarea
            {...c}
            data-autofocus
            rows={3}
            maxLength={BROADCAST_MESSAGE_MAX}
            value={state.message}
            onChange={(e) => change({ message: e.target.value })}
          />
        )}
      </FormField>
      <QuickMessages value={state.message} onPick={(message) => change({ message })} />
      <FormField label="Clear after" error={errors.clearAfter}>
        {(c) => (
          <Select
            {...c}
            options={CLEAR_CHOICES.map(({ value, label }) => ({ value, label }))}
            value={state.clear}
            onValueChange={(clear) => change({ clear })}
          />
        )}
      </FormField>
      {org && state.message.trim() ? (
        <LockScreenNotice org={org} text={state.message.trim()} />
      ) : null}
    </div>
  );
}

/** What the rule will do, by step, under the passes it would reach in the next 14 days. */
export function RuleReview({
  state,
  fields,
  names,
  preview,
  onEdit,
}: {
  state: RuleState;
  fields: readonly FieldDef[];
  /** Names of the chosen templates. */
  names: readonly string[];
  preview: Parameters<typeof RulePreview>[0];
  onEdit: (step: RuleStepId) => void;
}) {
  const sections: WizardReviewSection<RuleStepId>[] = [
    {
      id: 'passes',
      title: 'Passes',
      items: [
        { label: 'Name', value: state.name.trim() },
        { label: 'Templates', value: names.join(', ') },
        ...(state.match.length ? [{ label: 'Conditions', value: String(state.match.length) }] : []),
      ],
    },
    {
      id: 'when',
      title: 'When',
      items: [
        { label: 'Sends', value: whenSummary(state, fields) ?? '' },
        { label: 'Time zone', value: zoneLabel(state.timeZone || localZone()) },
      ],
    },
    {
      id: 'message',
      title: 'Message',
      items: [
        { label: 'Text', value: state.message.trim() },
        {
          label: 'Clear after',
          value: CLEAR_CHOICES.find((c) => c.value === state.clear)?.label ?? state.clear,
        },
      ],
    },
  ];
  return (
    <WizardReview
      sections={sections}
      onEdit={onEdit}
      preview={
        <div className="rounded-lg border border-border-strong bg-surface-raised p-4">
          <RulePreview {...preview} />
        </div>
      }
    />
  );
}
