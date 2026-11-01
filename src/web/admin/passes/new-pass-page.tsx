import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { isApiError } from '../../lib/errors.ts';
import { markMinted } from '../../lib/motion.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Callout,
  CheckboxField,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  SkeletonKeyValue,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
  Wizard,
} from '../../ui/index.ts';
import { useTemplate, useTemplates } from '../templates/api.ts';
import { passKeys } from './api.ts';
import { markCreated } from './detail/stage-state.ts';
import { fingerprint, newKey } from './format.ts';
import { LivePreview, type Preview } from './new-pass-preview.tsx';
import { ReviewStep } from './new-pass-review.tsx';
import { OrgStep, TemplateStep } from './new-pass-steps.tsx';
import {
  cleanValues,
  defaultValues,
  type FormValues,
  keysBoundTo,
  SchemaForm,
  validateValues,
} from './schema-form/index.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type StepId = 'org' | 'template' | 'details' | 'holder' | 'review';
const TITLES: Record<StepId, string> = {
  org: 'Organization',
  template: 'Template',
  details: 'Details',
  holder: 'Holder',
  review: 'Review',
};

export function NewPassPage({
  orgId: linkOrg,
  templateId: linkTemplate,
}: {
  orgId?: string | undefined;
  templateId?: string | undefined;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const scope = useOrgScope().orgId;
  const orgs = useOrgOptions();
  const active = useMemo(
    () => (orgs.data?.items ?? []).filter((o) => o.status === 'active'),
    [orgs.data],
  );
  const [orgId, setOrgId] = useState<string | undefined>(linkOrg ?? scope);
  const [templateId, setTemplateId] = useState<string | undefined>(linkTemplate);
  // A single active org needs no choice.
  useEffect(() => {
    if (!orgId && active.length === 1) setOrgId(active[0]?.id);
  }, [orgId, active]);
  const skipOrg = Boolean(linkOrg ?? scope) || active.length === 1;
  const ids: StepId[] = [
    ...(skipOrg ? [] : (['org'] as const)),
    'template',
    'details',
    'holder',
    'review',
  ];
  const steps = ids.map((id) => ({ id, title: TITLES[id] }));
  const [step, setStep] = useState<number>(() => (linkOrg && linkTemplate ? (skipOrg ? 1 : 2) : 0));
  const at = ids[Math.min(step, ids.length - 1)] ?? 'template';

  const templates = useTemplates({ orgId }, Boolean(orgId));
  const usable = useMemo(
    () => (templates.data?.items ?? []).filter((t) => t.status === 'active' && t.activeVersion),
    [templates.data],
  );
  const template = useTemplate(templateId);
  const schema = template.data?.inputSchema;
  const [input, setInput] = useState<FormValues>({});
  const [email, setEmail] = useState('');
  const [send, setSend] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [createdId, setCreatedId] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const onPreview = useCallback((p: Preview | undefined) => setPreview(p), []);

  // Seed schema defaults once per template so the form shows what the server applies.
  const seeded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!templateId || !schema || seeded.current === templateId) return;
    seeded.current = templateId;
    setInput(defaultValues(schema));
  }, [templateId, schema]);

  // The box checks itself the first time the address becomes valid; unchecking sticks.
  const validEmail = EMAIL.test(email.trim());
  const autoChecked = useRef(false);
  useEffect(() => {
    if (validEmail && !autoChecked.current) {
      autoChecked.current = true;
      setSend(true);
    }
  }, [validEmail]);

  const dirty = !createdId && (Object.keys(cleanValues(input)).length > 0 || email !== '');
  const guard = useUnsavedChangesGuard(dirty);
  const org = active.find((o) => o.id === orgId) ?? orgs.data?.items.find((o) => o.id === orgId);

  const payload = useMemo(
    () => ({
      orgId,
      templateId,
      input: cleanValues(input),
      ...(email.trim() ? { holderEmail: email.trim() } : {}),
      sendEmail: send && validEmail,
    }),
    [orgId, templateId, input, email, send, validEmail],
  );
  // The same payload on retry reuses the key, so a double submit cannot create two passes.
  const keyRef = useRef<{ fp: string; key: string }>({ fp: '', key: '' });
  const create = useMutation({
    mutationFn: () => {
      const fp = fingerprint(payload);
      if (keyRef.current.fp !== fp) keyRef.current = { fp, key: newKey() };
      return api.post('/api/v1/passes', PassDetailSchema, payload, {
        headers: { 'idempotency-key': keyRef.current.key },
      });
    },
    onSuccess: async (pass) => {
      await qc.invalidateQueries({ queryKey: passKeys.all });
      // The detail page renders its card on the first frame, so the preview morphs into it.
      qc.setQueryData(passKeys.detail(pass.id), pass);
      markMinted(pass.id);
      markCreated(
        pass.id,
        payload.sendEmail,
        (org && 'counts' in org ? org.counts.passes : 1) === 0,
      );
      setCreatedId(pass.id);
    },
  });
  useEffect(() => {
    if (createdId) void navigate({ to: `/admin/passes/${createdId}` as never });
  }, [createdId, navigate]);

  const fieldErrors = useMemo(() => {
    if (!isApiError(create.error)) return undefined;
    const out: Record<string, string> = {};
    for (const [path, msg] of Object.entries(create.error.fields))
      out[path.startsWith('input.') ? path.slice(6) : path] = msg;
    return out;
  }, [create.error]);
  const inputErrors = schema ? validateValues(schema, input) : {};
  const emailError =
    email.trim() && !validEmail ? 'Enter a valid email.' : fieldErrors?.holderEmail;
  const hiddenKeys = useMemo(
    () => keysBoundTo(template.data?.manifest, '/voided'),
    [template.data],
  );

  const go = (to: number) => setStep(Math.max(0, Math.min(ids.length - 1, to)));
  const index = (id: StepId) => ids.indexOf(id);
  function next() {
    if (at === 'org' && !orgId) return;
    if (at === 'template' && !templateId) return;
    if (at === 'details' && Object.keys(inputErrors).length > 0) return setShowErrors(true);
    if (at === 'holder' && emailError) return;
    if (at === 'review') return create.mutate();
    go(step + 1);
  }
  const chooseOrg = (id: string) => {
    if (id !== orgId) {
      setTemplateId(undefined);
      seeded.current = undefined;
      setInput({});
    }
    setOrgId(id);
  };
  const chooseTemplate = (id: string) => {
    if (id !== templateId) {
      seeded.current = undefined;
      setInput({});
    }
    setTemplateId(id);
  };

  const sample = (template.data?.sample ?? {}) as FormValues;
  const aside = (
    <LivePreview
      templateId={templateId}
      orgId={orgId}
      schema={schema}
      sample={sample}
      input={input}
      transitionName={createdId ? `pass-${createdId}` : undefined}
      onPreview={onPreview}
    />
  );

  return (
    <>
      <PageHeader
        title="New pass"
        breadcrumbs={[{ label: 'Passes', to: '/admin/passes' }, { label: 'New' }]}
      />
      <Wizard
        steps={steps}
        current={step}
        onStep={go}
        aside={aside}
        dirty={dirty}
        onCancel={() => void navigate({ to: '/admin/passes' })}
        {...(step > 0 ? { onBack: () => go(step - 1) } : {})}
        onNext={next}
        nextLabel={
          at === 'review' ? (payload.sendEmail ? 'Create and send' : 'Create pass') : 'Next'
        }
        busy={create.isPending}
      >
        {at === 'org' ? (
          <OrgStep
            orgs={active}
            loading={orgs.isPending}
            error={orgs.error}
            orgId={orgId}
            onSelect={chooseOrg}
            onCommit={(id) => {
              chooseOrg(id);
              go(step + 1);
            }}
          />
        ) : null}
        {at === 'template' ? (
          <TemplateStep
            templates={usable}
            loading={templates.isPending}
            error={templates.error}
            templateId={templateId}
            onSelect={chooseTemplate}
            onCommit={(id) => {
              chooseTemplate(id);
              go(step + 1);
            }}
          />
        ) : null}
        {at === 'details' ? (
          template.isError ? (
            <ErrorState error={template.error} onRetry={() => void template.refetch()} />
          ) : !template.data ? (
            <SkeletonKeyValue label="Loading fields" />
          ) : (
            <SchemaForm
              schema={template.data.inputSchema}
              value={input}
              onChange={setInput}
              hiddenKeys={hiddenKeys}
              showAllErrors={showErrors}
              serverErrors={fieldErrors}
            />
          )
        ) : null}
        {at === 'holder' ? (
          <div className="flex flex-col gap-4">
            <FormField
              label="Holder email"
              help="Leave empty to add a holder later."
              error={emailError}
            >
              {(c) => (
                <Input
                  {...c}
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </FormField>
            <CheckboxField
              label={validEmail ? `Email the pass to ${email.trim()}` : 'Email the pass'}
              checked={send && validEmail}
              disabled={!validEmail}
              onCheckedChange={(c) => setSend(c === true)}
            />
          </div>
        ) : null}
        {at === 'review' ? (
          <ReviewStep
            org={org?.name}
            template={template.data?.name}
            schema={schema}
            input={input}
            email={email}
            send={payload.sendEmail}
            steps={{
              ...(skipOrg ? {} : { org: index('org') }),
              template: index('template'),
              details: index('details'),
              holder: index('holder'),
            }}
            onEdit={go}
            brandingMissing={Boolean(preview?.warnings.some((w) => w.code === 'PLATFORM_BRANDING'))}
            warnings={(preview?.warnings ?? [])
              .filter((w) => w.severity === 'warning' && w.code !== 'PLATFORM_BRANDING')
              .map((w) => w.message)}
            error={
              create.isError ? (
                <Callout tone="danger">
                  {Object.keys(fieldErrors ?? {}).length > 0
                    ? 'Fix the highlighted fields on Details or Holder.'
                    : create.error.message}
                </Callout>
              ) : null
            }
          />
        ) : null}
      </Wizard>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
