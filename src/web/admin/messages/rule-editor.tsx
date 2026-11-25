import { useMemo, useState } from 'react';
import { BROADCAST_MESSAGE_MAX } from '@/shared/contracts/broadcasts.ts';
import type { MessageRuleDto } from '@/shared/contracts/message-rules.ts';
import { RULE_COPY } from '@/shared/copy/message-rules.ts';
import { useDebounced } from '../../lib/debounce.ts';
import { useOrgOptions } from '../../lib/search.ts';
import { localZone } from '../../lib/timezones.ts';
import {
  Button,
  Callout,
  Dialog,
  DialogClose,
  DialogContent,
  Form,
  FormField,
  Input,
  Select,
  Textarea,
  toast,
  useFormErrors,
} from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';
import { useTemplateDetails } from './audience.tsx';
import { commonFields } from './common-fields.ts';
import { CLEAR_CHOICES } from './labels.ts';
import { LockScreenNotice } from './lock-screen.tsx';
import { MatchEditor } from './match-editor.tsx';
import { QuickMessages } from './quick-messages.tsx';
import { RulePreview } from './rule-preview.tsx';
import { bodyOf, INITIAL_RULE, type RuleState, stateOfRule } from './rule-state.ts';
import { RuleWhen } from './rule-when.tsx';
import { useRuleActions, useRulePreview } from './rules-api.ts';
import { TemplateChoices } from './template-choices.tsx';

const FORM_ID = 'rule-editor';

function Section({
  title,
  last,
  children,
}: {
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`flex flex-col gap-3 ${last ? '' : 'border-b border-border pb-5'}`}>
      <h3 className="text-sm font-semibold text-fg-strong">{title}</h3>
      {children}
    </section>
  );
}

/** Create or edit an automatic message. Saving a paused rule turns it back on. */
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
  const change = (patch: Partial<RuleState>) => setState((s) => ({ ...s, ...patch }));
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
  const checks = useFormErrors(errors);
  const dirty = JSON.stringify(state) !== JSON.stringify(initial);
  const pending = actions.create.isPending || actions.update.isPending;

  const save = async () => {
    if (!body) return 'refused' as const;
    try {
      if (rule)
        await actions.update.mutateAsync({ id: rule.id, body: { ...body, version: rule.version } });
      else await actions.create.mutateAsync(body);
      toast.success('Saved');
      onClose();
      return 'saved' as const;
    } catch (e) {
      toast.error(e, 'Could not save');
      return 'failed' as const;
    }
  };
  const toggle = (id: string, on: boolean) =>
    change({
      templateIds: on ? [...state.templateIds, id] : state.templateIds.filter((x) => x !== id),
      // Conditions name inputs the remaining templates may not have.
      match: [],
    });

  return (
    <Dialog open dirty={dirty} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="lg"
        title={rule ? 'Edit automatic message' : 'New automatic message'}
        footer={
          <>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" form={FORM_ID} loading={pending}>
              {rule?.state === 'paused' ? 'Save and resume' : 'Save'}
            </Button>
          </>
        }
      >
        <Form id={FORM_ID} {...checks.form} onValid={save} className="flex flex-col gap-5">
          {rule?.pausedCode ? (
            <Callout tone="warning">{RULE_COPY.paused[rule.pausedCode]}</Callout>
          ) : null}
          <Section title="Passes">
            <FormField label="Name" error={checks.errors.name}>
              {(c) => (
                <Input
                  {...c}
                  maxLength={80}
                  value={state.name}
                  onChange={(e) => change({ name: e.target.value })}
                />
              )}
            </FormField>
            <TemplateChoices
              orgId={orgId}
              templates={usable}
              loading={templates.isPending}
              details={details}
              chosen={state.templateIds}
              needsMessage
              onToggle={toggle}
              error={checks.errors.templates}
            />
            <MatchEditor
              fields={fields}
              value={state.match}
              onChange={(match) => change({ match })}
              error={checks.errors.match}
            />
          </Section>
          <Section title="When">
            <RuleWhen state={state} onChange={change} fields={fields} errors={checks.errors} />
          </Section>
          <Section title="Message">
            <FormField
              label="Text"
              error={checks.errors.message}
              help={`${state.message.length} of ${BROADCAST_MESSAGE_MAX}. Keep private details out.`}
            >
              {(c) => (
                <Textarea
                  {...c}
                  rows={3}
                  maxLength={BROADCAST_MESSAGE_MAX}
                  value={state.message}
                  onChange={(e) => change({ message: e.target.value })}
                />
              )}
            </FormField>
            <QuickMessages value={state.message} onPick={(message) => change({ message })} />
            <FormField label="Clear after">
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
              <LockScreenNotice
                org={{ id: org.id, name: org.name, accent: org.branding.accent ?? null }}
                text={state.message.trim()}
              />
            ) : null}
          </Section>
          <Section title="Who is due" last>
            <RulePreview data={preview.data} blocked={!body} loading={preview.isFetching} />
          </Section>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
