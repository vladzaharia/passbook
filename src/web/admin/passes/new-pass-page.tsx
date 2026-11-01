import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PassDetailSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { isApiError } from '../../lib/errors.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  Spinner,
  Switch,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import { useDraftPreview, useTemplate } from '../templates/api.ts';
import { passKeys } from './api.ts';
import { fingerprint, newKey } from './format.ts';
import { OrgStep, TemplateStep } from './new-pass-steps.tsx';
import { PassPreview } from './pass-preview.tsx';
import {
  cleanValues,
  defaultValues,
  type FormValues,
  keysBoundTo,
  SchemaForm,
  validateValues,
} from './schema-form/index.ts';

const STEPS = ['Organization', 'Template', 'Details', 'Holder', 'Create'] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function LivePreview({
  templateId,
  input,
  schema,
}: {
  templateId: string;
  input: FormValues;
  schema: unknown;
}) {
  const debounced = useDebounced(cleanValues(input), 300);
  const valid = Object.keys(validateValues(schema, debounced)).length === 0;
  const preview = useDraftPreview(valid ? templateId : undefined, debounced);
  return (
    <Card className="lg:sticky lg:top-4 lg:self-start">
      <CardHeader
        title="Preview"
        actions={preview.isFetching ? <Spinner label="Updating preview" /> : null}
      />
      <CardBody>
        {preview.data ? (
          <PassPreview
            passJson={preview.data.passJson}
            assetBaseUrl={preview.data.assetBaseUrl}
            assetNames={preview.data.assetNames}
          />
        ) : preview.isError || !valid ? (
          <p className="text-sm text-fg-muted">Preview unavailable until the details are valid.</p>
        ) : (
          <Spinner />
        )}
        {preview.data?.warnings.length ? (
          <ul className="mt-3 list-disc pl-5 text-xs text-warning">
            {preview.data.warnings.map((w) => (
              <li key={`${w.code}${w.path ?? ''}`}>{w.message}</li>
            ))}
          </ul>
        ) : null}
      </CardBody>
    </Card>
  );
}

export function NewPassPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [orgId, setOrgId] = useState<string>();
  const [templateId, setTemplateId] = useState<string>();
  const [input, setInput] = useState<FormValues>({});
  const [email, setEmail] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [createdId, setCreatedId] = useState<string>();
  const template = useTemplate(templateId);
  const schema = template.data?.inputSchema;

  const dirty =
    !createdId && (orgId !== undefined || Object.keys(input).length > 0 || email !== '');
  const guard = useUnsavedChangesGuard(dirty);

  // Seed schema defaults once per template so the form shows what the server applies.
  const seeded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!templateId || !schema || seeded.current === templateId) return;
    seeded.current = templateId;
    setInput(defaultValues(schema));
  }, [templateId, schema]);

  useEffect(() => {
    if (createdId) void navigate({ to: `/admin/passes/${createdId}` as never });
  }, [createdId, navigate]);

  const payload = useMemo(
    () => ({
      orgId,
      templateId,
      input: cleanValues(input),
      ...(email.trim() ? { holderEmail: email.trim() } : {}),
      sendEmail: sendEmail && Boolean(email.trim()),
    }),
    [orgId, templateId, input, email, sendEmail],
  );
  // Same payload on retry reuses the key, so a double submit cannot create two passes.
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
      setCreatedId(pass.id);
    },
  });

  const fieldErrors = useMemo(() => {
    if (!isApiError(create.error)) return undefined;
    const out: Record<string, string> = {};
    for (const [path, msg] of Object.entries(create.error.fields)) {
      out[path.startsWith('input.') ? path.slice(6) : path] = msg;
    }
    return out;
  }, [create.error]);

  const inputErrors = schema ? validateValues(schema, input) : {};
  const emailError =
    email.trim() && !EMAIL.test(email.trim()) ? 'Enter a valid email.' : fieldErrors?.holderEmail;

  function next() {
    if (step === 2 && Object.keys(inputErrors).length > 0) return setShowErrors(true);
    if (step === 3 && emailError) return;
    setStep((s) => s + 1);
  }

  const stepRef = useRef<HTMLLIElement>(null);
  const firstStep = useRef(true);
  // A new step opens at its top, not at the previous step's scroll offset.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on step change only
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepRef.current?.focus();
  }, [step]);

  const hiddenKeys = useMemo(
    () => keysBoundTo(template.data?.manifest, '/voided'),
    [template.data],
  );

  const canNext =
    (step === 0 && orgId) ||
    (step === 1 && templateId && template.data) ||
    step === 2 ||
    step === 3;

  return (
    <>
      <PageHeader
        title="New pass"
        breadcrumbs={[{ label: 'Passes', to: '/admin/passes' }, { label: 'New' }]}
      />
      <ol className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li
            key={label}
            ref={i === step ? stepRef : undefined}
            tabIndex={i === step ? -1 : undefined}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'scroll-mt-20 outline-none',
              i === step ? 'font-medium text-fg-strong' : 'text-fg-muted',
            )}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <OrgStep
          orgId={orgId}
          onSelect={(id) => {
            if (id !== orgId) {
              setTemplateId(undefined);
              seeded.current = undefined;
              setInput({});
            }
            setOrgId(id);
          }}
        />
      ) : null}
      {step === 1 && orgId ? (
        <TemplateStep
          orgId={orgId}
          templateId={templateId}
          onSelect={(id) => {
            if (id !== templateId) {
              seeded.current = undefined;
              setInput({});
            }
            setTemplateId(id);
          }}
        />
      ) : null}
      {step === 2 && templateId ? (
        template.isError ? (
          <ErrorState error={template.error} onRetry={() => void template.refetch()} />
        ) : !template.data ? (
          <Spinner />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
            <SchemaForm
              schema={template.data.inputSchema}
              value={input}
              onChange={setInput}
              hiddenKeys={hiddenKeys}
              showAllErrors={showErrors}
              serverErrors={fieldErrors}
            />
            <LivePreview templateId={templateId} input={input} schema={template.data.inputSchema} />
          </div>
        )
      ) : null}
      {step === 3 ? (
        <div className="grid max-w-md gap-4">
          <FormField label="Holder email" help="Leave empty to assign later." error={emailError}>
            {(c) => (
              <Input
                {...c}
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (!e.target.value.trim()) setSendEmail(false);
                }}
              />
            )}
          </FormField>
          <FormField label="Email the pass to the holder">
            {(c) => (
              <Switch
                id={c.id}
                checked={sendEmail}
                disabled={!email.trim() || Boolean(emailError)}
                onCheckedChange={setSendEmail}
              />
            )}
          </FormField>
        </div>
      ) : null}
      {step === 4 ? (
        <div className="max-w-md">
          <Card>
            <CardHeader title="Review" />
            <CardBody className="flex flex-col gap-1 text-sm">
              <p>Template: {template.data?.name}</p>
              <p>Holder: {email.trim() || 'Unassigned'}</p>
              <p>Email on create: {payload.sendEmail ? 'Yes' : 'No'}</p>
            </CardBody>
          </Card>
          {create.isError &&
          !fieldErrors?.holderEmail &&
          Object.keys(fieldErrors ?? {}).length === 0 ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {create.error.message}
            </p>
          ) : null}
          {create.isError && Object.keys(fieldErrors ?? {}).length > 0 ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              Fix the highlighted fields on Details or Holder.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-8 flex gap-2">
        {step > 0 ? (
          <Button variant="outline" disabled={create.isPending} onClick={() => setStep(step - 1)}>
            Back
          </Button>
        ) : null}
        {step < 4 ? (
          <Button disabled={!canNext} onClick={next}>
            Next
          </Button>
        ) : (
          <Button loading={create.isPending} onClick={() => create.mutate()}>
            Create pass
          </Button>
        )}
      </div>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
