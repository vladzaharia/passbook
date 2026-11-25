import { useMemo, useState } from 'react';
import type { MessageRuleDto } from '@/shared/contracts/message-rules.ts';
import { RULE_COPY } from '@/shared/copy/message-rules.ts';
import { useDebounced } from '../../lib/debounce.ts';
import { useOrgOptions } from '../../lib/search.ts';
import { localZone } from '../../lib/timezones.ts';
import { Callout, toast, useWizard, WizardDialog } from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';
import { useTemplateDetails } from './audience.tsx';
import { commonFields } from './common-fields.ts';
import { bodyOf, INITIAL_RULE, type RuleState, stateOfRule } from './rule-state.ts';
import {
  RULE_FIELD_STEP,
  RULE_HINTS,
  RULE_STEPS,
  RuleReview,
  StepMessage,
  StepPasses,
  stepErrors,
  whenSummary,
} from './rule-steps.tsx';
import { RuleWhen } from './rule-when.tsx';
import { useRuleActions, useRulePreview } from './rules-api.ts';

/** Create (four steps) or edit (the same steps, any order) an automatic message. */
export function RuleEditor({
  orgId,
  rule,
  onClose,
}: {
  orgId: string;
  rule?: MessageRuleDto | undefined;
  onClose: () => void;
}) {
  const initial = useMemo(
    () => (rule ? stateOfRule(rule) : { ...INITIAL_RULE, timeZone: localZone() }),
    [rule],
  );
  const [state, setState] = useState<RuleState>(initial);
  const org = useOrgOptions().data?.items.find((o) => o.id === orgId);
  const templates = useTemplates({ orgId });
  const usable = useMemo(
    () =>
      (templates.data?.items ?? []).filter(
        (t) => (t.orgId === null || t.orgId === orgId) && t.status === 'active' && t.activeVersion,
      ),
    [orgId, templates.data],
  );
  const details = useTemplateDetails(usable, orgId);
  const chosen = state.templateIds.flatMap((id) => details.get(id) ?? []);
  const fields = useMemo(() => commonFields(chosen), [chosen]);
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const { body, errors } = bodyOf(orgId, state, byKey);
  const settled = useDebounced(body);
  const preview = useRulePreview(settled && body ? settled : undefined, rule?.id);
  const actions = useRuleActions(orgId);
  const changed = JSON.stringify(state) !== JSON.stringify(initial);
  const resuming = rule?.state === 'paused';
  const pending = actions.create.isPending || actions.update.isPending;

  const w = useWizard({
    open: true,
    mode: rule ? 'edit' : 'create',
    steps: RULE_STEPS.map((s) => ({
      ...s,
      summary:
        s.id === 'passes'
          ? state.name.trim() || undefined
          : s.id === 'when'
            ? whenSummary(state, fields)
            : undefined,
    })),
    errors: stepErrors(errors),
    hints: RULE_HINTS,
    fieldStep: RULE_FIELD_STEP,
    // Saving a paused rule turns it back on, so that counts as a change.
    dirty: changed || resuming,
    onFinish: async () => {
      if (!body) return;
      if (rule)
        await actions.update.mutateAsync({ id: rule.id, body: { ...body, version: rule.version } });
      else await actions.create.mutateAsync(body);
      toast.success('Saved');
      onClose();
    },
  });
  const change = (patch: Partial<RuleState>) => {
    setState((s) => ({ ...s, ...patch }));
    w.clearServer();
  };
  const toggle = (id: string, on: boolean) =>
    change({
      templateIds: on ? [...state.templateIds, id] : state.templateIds.filter((x) => x !== id),
      // Conditions name inputs the remaining templates may not have.
      match: [],
    });

  return (
    <WizardDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={rule ? 'Edit automatic message' : 'New automatic message'}
      wizard={w}
      dirty={changed}
      finishLabel={rule ? (resuming ? 'Save and resume' : 'Save') : 'Create message'}
      busy={pending}
      notice={
        rule?.pausedCode ? (
          <Callout tone="warning">{RULE_COPY.paused[rule.pausedCode]}</Callout>
        ) : null
      }
    >
      {w.id === 'passes' ? (
        <StepPasses
          orgId={orgId}
          state={state}
          change={change}
          fields={fields}
          errors={w.errors}
          templates={usable}
          loading={templates.isPending}
          details={details}
          onToggle={toggle}
        />
      ) : null}
      {w.id === 'when' ? (
        <RuleWhen state={state} onChange={change} fields={fields} errors={w.errors} />
      ) : null}
      {w.id === 'message' ? (
        <StepMessage
          state={state}
          change={change}
          errors={w.errors}
          org={
            org ? { id: org.id, name: org.name, accent: org.branding.accent ?? null } : undefined
          }
        />
      ) : null}
      {w.id === 'review' ? (
        <RuleReview
          state={state}
          fields={fields}
          names={usable.filter((t) => state.templateIds.includes(t.id)).map((t) => t.name)}
          preview={{ data: preview.data, blocked: !body, loading: preview.isFetching }}
          onEdit={w.go}
        />
      ) : null}
    </WizardDialog>
  );
}
