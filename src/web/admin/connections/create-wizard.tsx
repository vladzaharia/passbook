import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import { ConnectionSchema, type CreateConnectionSchema } from '@/shared/contracts/connections.ts';
import { api } from '../../lib/api.ts';
import { errorMessage, isApiError } from '../../lib/errors.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  ErrorState,
  PageHeader,
  SkeletonKeyValue,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
  Wizard,
} from '../../ui/index.ts';
import {
  cleanValues,
  describeSchema,
  flatFields,
  validateValues,
} from '../passes/schema-form/index.ts';
import { useTemplate } from '../templates/api.ts';
import { connectionKeys, useConnector, useConnectors } from './api.ts';
import { flattenSchema, nestValues, prefixed, WIZARD_HIDDEN } from './config-schema.ts';
import { CreatedStep } from './created-step.tsx';
import {
  type Lifecycle,
  LifecycleFields,
  lifecycleError,
  lifecycleToPatch,
} from './lifecycle-fields.tsx';
import { fromRows, type MappingRow } from './mapping.ts';
import { MappingEditor, targetsOf } from './mapping-editor.tsx';
import { TemplateSelect } from './template-select.tsx';
import type { TestOutcome } from './test-result.tsx';
import { generateSecret } from './webhook.tsx';
import { ReviewStep, WizardAside } from './wizard-review.tsx';
import { type ConfigDraft, ConfigStep, ConnectorStep } from './wizard-steps.tsx';

const STEPS = [
  { id: 'connector', title: 'Connector' },
  { id: 'config', title: 'Configuration' },
  { id: 'mapping', title: 'Mapping' },
  { id: 'lifecycle', title: 'Lifecycle' },
  { id: 'review', title: 'Review' },
] as const;

const DEFAULT_LIFE: Lifecycle = {
  mode: 'poll',
  intervalMinutes: '',
  holderEmailField: '',
  defaultTemplateId: '',
  autoCreate: false,
  autoEmail: false,
  onMissing: 'flag',
};

type CreateBody = z.input<typeof CreateConnectionSchema>;

export function CreateConnectionWizard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { orgId: scoped } = useOrgScope();
  const orgs = useOrgOptions();
  const connectors = useConnectors();
  const [step, setStep] = useState(0);
  const [orgId, setOrgId] = useState<string | undefined>(scoped);
  const [type, setType] = useState<string>();
  const [draft, setDraft] = useState<ConfigDraft>({ name: '', config: {}, secrets: {} });
  const [test, setTest] = useState<TestOutcome>();
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [life, setLife] = useState<Lifecycle>(DEFAULT_LIFE);
  const [showErrors, setShowErrors] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string | null; secret?: string }>();
  const connector = useConnector(type);
  const template = useTemplate(life.defaultTemplateId || undefined);

  const dirty = !created && (Boolean(type) || draft.name !== '' || rows.length > 0);
  const guard = useUnsavedChangesGuard(dirty);
  const info = connector.data;
  const flat = useMemo(() => flattenSchema(info?.configSchema), [info]);
  const authType = String(draft.config['auth.type'] ?? 'none');
  const shownSecrets = useMemo(() => {
    const hidden = WIZARD_HIDDEN(flattenSchema(info?.secretSchema), authType);
    return Object.fromEntries(
      Object.entries(cleanValues(draft.secrets))
        .filter(([k]) => !hidden.has(k))
        .map(([k, v]) => [k, String(v)]),
    );
  }, [info, draft.secrets, authType]);
  const cfgErrors = flat ? validateValues(flat, draft.config) : {};
  const secErrors = useMemo(() => {
    const schema = info?.secretSchema;
    if (!schema) return {};
    const hidden = WIZARD_HIDDEN(flattenSchema(schema), authType);
    return Object.fromEntries(
      Object.entries(validateValues(schema, draft.secrets)).filter(([k]) => !hidden.has(k)),
    );
  }, [info, draft.secrets, authType]);
  const mapped = fromRows(rows);
  const lifeError = lifecycleError(life);
  const sample =
    test?.kind === 'result' && test.result.sample
      ? test.result.sample
      : Object.keys(info?.outputFields ?? {}).map((k) => ({ pointer: `/${k}` }));
  const targets = template.data
    ? targetsOf(flatFields(describeSchema(template.data.inputSchema)))
    : [];
  const defaultMinutes = info ? Math.round(info.defaults.intervalSeconds / 60) : undefined;

  // Start from the first mode the connector supports.
  useEffect(() => {
    const caps = info?.capabilities;
    if (!caps) return;
    setLife((l) => ({ ...l, mode: caps.poll ? 'poll' : caps.webhook ? 'webhook' : 'manual' }));
  }, [info]);

  const create = useMutation({
    mutationFn: async () => {
      const wantsWebhook = life.mode === 'webhook' || life.mode === 'hybrid';
      const webhookSecret = wantsWebhook ? generateSecret() : undefined;
      const body: CreateBody = {
        orgId: orgId as string,
        connectorType: type as string,
        name: draft.name.trim(),
        config: nestValues(cleanValues(draft.config)) as CreateBody['config'],
        ...(Object.keys(shownSecrets).length ? { secrets: shownSecrets } : {}),
        ...(Object.keys(mapped.mapping).length > 0 ? { mapping: mapped.mapping } : {}),
        ...lifecycleToPatch(life),
        ...(webhookSecret ? { webhookSecret } : {}),
      };
      const connection = await api.post('/api/v1/connections', ConnectionSchema, body);
      return { connection, webhookSecret };
    },
    onSuccess: async ({ connection, webhookSecret }) => {
      await qc.invalidateQueries({ queryKey: connectionKeys.all });
      setCreated({ id: connection.id, url: connection.webhookUrl, secret: webhookSecret });
    },
  });
  const open = (id: string) => void navigate({ to: `/admin/connections/${id}` as never });
  // Without a secret to show, the new connection opens at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigate once per creation
  useEffect(() => {
    if (created && !created.secret) open(created.id);
  }, [created]);

  const serverFields = isApiError(create.error) ? create.error.fields : {};
  const crumbs = [{ label: 'Connections', to: '/admin/connections' }, { label: 'New' }];
  const blockCreate = life.autoCreate && (!life.defaultTemplateId || rows.length === 0);

  function next() {
    if (step === 0 && (!orgId || !type)) return setShowErrors(true);
    const invalid = Object.keys(cfgErrors).length + Object.keys(secErrors).length > 0;
    if (step === 1 && (!draft.name.trim() || invalid)) return setShowErrors(true);
    if (step === 2 && Object.keys(mapped.errors).length > 0) return setShowErrors(true);
    if (step === 3 && lifeError) return setShowErrors(true);
    setShowErrors(false);
    if (step === STEPS.length - 1) {
      if (!blockCreate) create.mutate();
      return;
    }
    setStep((s) => s + 1);
  }

  if (created?.secret) {
    return (
      <>
        <PageHeader title="Connection created" breadcrumbs={crumbs} />
        <CreatedStep
          url={created.url}
          secret={created.secret}
          connectorType={type ?? ''}
          onDone={() => open(created.id)}
        />
      </>
    );
  }

  const orgList = orgs.data?.items ?? [];
  const orgName = orgList.find((o) => o.id === orgId)?.name ?? '—';
  return (
    <>
      <PageHeader title="New connection" breadcrumbs={crumbs} />
      <Wizard
        steps={STEPS}
        current={step}
        onStep={setStep}
        aside={<WizardAside connector={info} sample={sample} />}
        dirty={dirty}
        onCancel={() => void navigate({ to: '/admin/connections' })}
        onBack={step > 0 ? () => setStep(step - 1) : undefined}
        onNext={next}
        nextLabel={step === STEPS.length - 1 ? 'Create' : 'Next'}
        nextDisabled={step === STEPS.length - 1 && blockCreate}
        busy={create.isPending}
      >
        {step === 0 ? (
          <ConnectorStep
            connectors={connectors.data?.items ?? []}
            loading={connectors.isPending}
            type={type}
            onType={(t) => {
              if (t === type) return;
              setType(t);
              setDraft((d) => ({ ...d, config: {}, secrets: {} }));
              setTest(undefined);
            }}
            onCommit={next}
            orgs={scoped ? null : orgList}
            orgId={orgId}
            onOrg={setOrgId}
          />
        ) : null}
        {step === 0 && connectors.isError ? (
          <ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} />
        ) : null}
        {step === 0 && showErrors && (!orgId || !type) ? (
          <p className="text-sm text-danger">
            {!orgId ? 'Choose an organization.' : 'Choose a connector.'}
          </p>
        ) : null}
        {step === 1 ? (
          info && orgId ? (
            <ConfigStep
              connector={info}
              orgId={orgId}
              draft={draft}
              onChange={setDraft}
              showErrors={showErrors}
              serverErrors={{
                config: prefixed(serverFields, 'config.'),
                secrets: prefixed(serverFields, 'secrets.'),
              }}
              test={test}
              onTest={setTest}
            />
          ) : connector.isError ? (
            <ErrorState error={connector.error} onRetry={() => void connector.refetch()} />
          ) : (
            <SkeletonKeyValue label="Loading connector" />
          )
        ) : null}
        {step === 2 ? (
          <>
            <TemplateSelect
              orgId={orgId}
              value={life.defaultTemplateId}
              onChange={(defaultTemplateId) => setLife({ ...life, defaultTemplateId })}
            />
            <MappingEditor
              rows={rows}
              onChange={setRows}
              errors={showErrors ? mapped.errors : {}}
              targets={targets}
              sources={sample}
            />
          </>
        ) : null}
        {step === 3 ? (
          <LifecycleFields
            value={life}
            onChange={setLife}
            capabilities={info?.capabilities}
            defaultMinutes={defaultMinutes}
            error={showErrors ? lifeError : undefined}
          />
        ) : null}
        {step === 4 ? (
          <>
            <ReviewStep
              orgName={orgName}
              connector={info}
              name={draft.name}
              life={life}
              templateName={template.data?.name}
              mappings={Object.keys(mapped.mapping).length}
              defaultMinutes={defaultMinutes}
              onEdit={setStep}
            />
            {blockCreate ? (
              <p className="text-sm text-danger">
                Creating passes needs a template and mappings. Turn it off or add them.
              </p>
            ) : null}
            {create.isError ? (
              <p className="text-sm text-danger">
                {Object.keys(serverFields).length > 0
                  ? 'Fix the highlighted fields on Configuration.'
                  : errorMessage(create.error)}
              </p>
            ) : null}
          </>
        ) : null}
      </Wizard>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
