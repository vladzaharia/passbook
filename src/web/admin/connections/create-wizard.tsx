import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { fromRows, type MappingRow } from '../mapping/mapping.ts';
import { targetsOf } from '../mapping/mapping-editor.tsx';
import { markCreated } from '../passes/created.tsx';
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { useTemplate } from '../templates/api.ts';
import { useConnector, useConnectors } from './api.ts';
import { prefixed } from './config-schema.ts';
import { CreatedStep } from './created-step.tsx';
import { UploadConfig } from './files/upload-config.tsx';
import { useUploadDraft } from './files/use-upload-draft.ts';
import { takeConnectionPrefill, wizardStart } from './import-handoff.ts';
import { type Lifecycle, LifecycleFields, lifecycleError } from './lifecycle-fields.tsx';
import { useRestSample } from './rest/use-mapping-seed.ts';
import { useConnectionCreation } from './use-connection-creation.ts';
import { useWizardRecipe } from './use-wizard-recipe.ts';
import { useWizardConfig } from './wizard-config.ts';
import { WizardMapping } from './wizard-mapping.tsx';
import { ReviewStep, WizardAside } from './wizard-review.tsx';
import { type ConfigDraft, ConfigStep, ConnectorStep } from './wizard-steps.tsx';
import { useTestOutcome } from './wizard-test.tsx';

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
  voidWhen: [],
};

export function CreateConnectionWizard() {
  const navigate = useNavigate();
  const { orgId, setOrgId, membership } = useOrgScope();
  // Bind asynchronous results to this principal and visit to an organization.
  const userId = membership?.userId;
  const scopeToken = useMemo(() => ({ orgId, userId }), [orgId, userId]);
  const currentScope = useRef(scopeToken);
  currentScope.current = scopeToken;
  const orgs = useOrgOptions();
  const connectors = useConnectors(orgId);
  // From an import's "Keep this sheet in sync": the sheet connector, its link and the import's mapping.
  const [start] = useState(() => wizardStart(takeConnectionPrefill(), DEFAULT_LIFE));
  const [step, setStep] = useState(start.step);
  const [type, setType] = useState<string | undefined>(start.type);
  const [draft, setDraft] = useState<ConfigDraft>(start.draft);
  const [test, onTested] = useTestOutcome({
    orgId,
    scope: scopeToken,
    current: currentScope,
    type,
    draft,
  });
  const [rows, setRows] = useState<MappingRow[]>(start.rows);
  const [life, setLife] = useState<Lifecycle>(start.life);
  const [showErrors, setShowErrors] = useState(false);
  const [createdResult, setCreated] = useState<{
    id: string;
    url: string | null;
    secret?: string;
    scope: typeof scopeToken;
  }>();
  const created = createdResult?.scope === scopeToken ? createdResult : undefined;
  const connector = useConnector(type, orgId);
  const templateOrg = membership?.capabilities.includes('templates:read') ? orgId : undefined;
  const template = useTemplate(
    templateOrg ? life.defaultTemplateId || undefined : undefined,
    templateOrg,
  );
  const selectedTemplate =
    templateOrg &&
    template.data &&
    (template.data.orgId === null || template.data.orgId === templateOrg)
      ? template.data
      : undefined;

  const [restSample, setRestSample] = useRestSample(selectedTemplate, rows, setRows, setLife);
  const upload = useUploadDraft({ orgId, setDraft, onSample: setRestSample });
  const dirty = !created && (Boolean(type) || draft.name !== '' || rows.length > 0);
  const guard = useUnsavedChangesGuard(dirty);
  const info = connector.data;
  const isUpload = info?.capabilities.upload === true;
  const { cfgErrors, secErrors, shownSecrets } = useWizardConfig(info, draft);
  const mapped = fromRows(rows);
  const lifeError = lifecycleError(life);
  const sender = useWizardRecipe({ info, draft, setDraft, setRows, setLife });
  const declared = Object.keys(sender.recipe?.outputFields ?? info?.outputFields ?? {});
  const tested = test?.kind === 'result' ? test.result.sample : undefined;
  const sample =
    tested ?? (restSample.length > 0 ? restSample : declared.map((k) => ({ pointer: `/${k}` })));
  const targets = selectedTemplate
    ? targetsOf(flatFields(describeSchema(selectedTemplate.inputSchema)))
    : [];
  const defaultMinutes = info ? Math.round(info.defaults.intervalSeconds / 60) : undefined;

  useEffect(() => {
    const caps = info?.capabilities;
    if (!caps) return;
    setLife((l) => ({ ...l, mode: caps.poll ? 'poll' : caps.webhook ? 'webhook' : 'manual' }));
  }, [info]);
  const create = useConnectionCreation({
    currentScope,
    life,
    type,
    draft,
    shownSecrets,
    mapping: mapped.mapping,
    fileId: isUpload ? upload.file?.id : undefined,
    onCreated: setCreated,
  });

  // The new connection's page replaces the wizard in history and leads with its next steps.
  const open = (id: string) => {
    markCreated(`connection:${id}`);
    void navigate({
      to: '/admin/connections/$connectionId',
      params: { connectionId: id },
      replace: true,
    });
  };
  // Without a secret to show, the new connection opens at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigate once per creation
  useEffect(() => {
    if (created && !created.secret && !sender.pasted) open(created.id);
  }, [created]);

  const currentCreate = create.variables?.scope === scopeToken;
  const serverFields = currentCreate && isApiError(create.error) ? create.error.fields : {};
  const crumbs = [{ label: 'Connections', to: '/admin/connections' }, { label: 'New' }];
  const noMappings = rows.length === 0;
  const blockCreate = life.autoCreate && (!life.defaultTemplateId || noMappings);

  /** False keeps the step: the Wizard focuses the first error and announces the count. */
  function next(): boolean {
    const invalid =
      Object.keys(cfgErrors).length + Object.keys(secErrors).length > 0 ||
      Boolean(sender.secretError);
    const blocked =
      (step === 0 && (!orgId || !type)) ||
      (step === 1 && (!draft.name.trim() || invalid || (isUpload && !upload.file))) ||
      (step === 2 && Object.keys(mapped.errors).length > 0) ||
      (step === 3 && Boolean(lifeError));
    if (blocked) {
      setShowErrors(true);
      return false;
    }
    setShowErrors(false);
    if (step === STEPS.length - 1) {
      if (!blockCreate && orgId) create.mutate({ orgId, scope: scopeToken });
      return true;
    }
    setStep((s) => s + 1);
    return true;
  }

  if (created && (created.secret || sender.pasted)) {
    return (
      <>
        <PageHeader title="Connection created" breadcrumbs={crumbs} />
        <CreatedStep
          url={created.url}
          secret={created.secret}
          connectorType={type ?? ''}
          sender={sender.recipe}
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
        aside={<WizardAside connector={info} sample={sample} step={step} />}
        asideLabel="Connector"
        onCancel={() => void navigate({ to: '/admin/connections' })}
        onBack={step > 0 ? () => setStep(step - 1) : undefined}
        onNext={next}
        nextLabel={
          step < STEPS.length - 1 ? 'Next' : noMappings ? 'Create without mappings' : 'Create'
        }
        nextHint="Pick a connector."
        nextDisabled={(step === 0 && !type) || (step === STEPS.length - 1 && blockCreate)}
        busy={currentCreate && create.isPending}
      >
        {step === 0 ? (
          <ConnectorStep
            connectors={connectors.data?.items ?? []}
            loading={connectors.isPending}
            type={type}
            onType={(t) => {
              if (t === type) return;
              setType(t);
              setRestSample([]);
              setDraft((d) => ({ ...d, config: {}, secrets: {} }));
            }}
            onCommit={next}
            orgs={orgId ? null : orgList}
            orgId={orgId}
            onOrg={setOrgId}
            showErrors={showErrors}
          />
        ) : null}
        {step === 0 && connectors.isError ? (
          <ErrorState inline error={connectors.error} onRetry={() => void connectors.refetch()} />
        ) : null}
        {step === 1 ? (
          info && orgId && isUpload ? (
            <UploadConfig
              upload={upload}
              draft={draft}
              onChange={setDraft}
              showErrors={showErrors}
              idError={cfgErrors.idColumn ?? serverFields['config.idColumn']}
            />
          ) : info && orgId ? (
            <ConfigStep
              key={orgId}
              connector={info}
              orgId={orgId}
              draft={draft}
              onChange={setDraft}
              showErrors={showErrors}
              serverErrors={{
                config: prefixed(serverFields, 'config.'),
                secrets: prefixed(serverFields, 'secrets.'),
                signing: serverFields.webhookSecret,
              }}
              test={test}
              onTest={onTested}
              onRecipe={sender.pick}
              onSample={setRestSample}
              secretError={sender.secretError}
            />
          ) : connector.isError ? (
            <ErrorState inline error={connector.error} onRetry={() => void connector.refetch()} />
          ) : (
            <SkeletonKeyValue label="Loading connector" />
          )
        ) : null}
        {step === 2 ? (
          <WizardMapping
            info={info}
            orgId={orgId}
            templateOrg={templateOrg}
            life={life}
            setLife={setLife}
            draft={draft}
            test={test}
            onTest={onTested}
            rows={rows}
            setRows={setRows}
            errors={showErrors ? mapped.errors : {}}
            targets={targets}
            sources={sample}
          />
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
              templateName={selectedTemplate?.name}
              mappings={Object.keys(mapped.mapping).length}
              defaultMinutes={defaultMinutes}
              upload={isUpload}
              onEdit={setStep}
            />
            {blockCreate ? (
              <p className="text-sm text-danger">
                Creating passes needs a template and mappings. Turn it off or add them.
              </p>
            ) : null}
            {currentCreate && create.isError ? (
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
