import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isApiError } from '../../lib/errors.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  ErrorState,
  PageHeader,
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
import { ConnectorStep } from './connector-picker.tsx';
import { buildTiles, type ConnectorTile, OUTBOUND, tileKey } from './connector-tiles.ts';
import { PASSBOOK_STEPS, railSteps, type SecretOrigin } from './create-wizard-steps.ts';
import { useUploadDraft } from './files/use-upload-draft.ts';
import { takeConnectionPrefill, wizardStart } from './import-handoff.ts';
import { type Lifecycle, lifecycleError } from './lifecycle-fields.tsx';
import { useRestSample } from './rest/use-mapping-seed.ts';
import { useRecipeSetup } from './setup-api.ts';
import { holdSecret } from './setup-handoff.ts';
import { useConnectionCreation } from './use-connection-creation.ts';
import { useWizardRecipe } from './use-wizard-recipe.ts';
import { WizardBody } from './wizard-body.tsx';
import { useWizardConfig } from './wizard-config.ts';
import { WizardAside } from './wizard-review.tsx';
import type { ConfigDraft } from './wizard-steps.tsx';
import { useTestOutcome } from './wizard-test.tsx';

const REVIEW = PASSBOOK_STEPS.length - 1;

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

/** `source` preselects a tile (a sender's id, a connector type or `custom`) and skips the pick. */
export function CreateConnectionWizard({ source }: { source?: string | undefined } = {}) {
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
    secret?: string | undefined;
    scope: typeof scopeToken;
  }>();
  const created = createdResult?.scope === scopeToken ? createdResult : undefined;
  const connector = useConnector(type === OUTBOUND ? undefined : type, orgId);
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
  const dirty =
    !created && type !== OUTBOUND && (Boolean(type) || draft.name !== '' || rows.length > 0);
  const guard = useUnsavedChangesGuard(dirty);

  const info = connector.data;
  const isUpload = info?.capabilities.upload === true;
  const { cfgErrors, secErrors, shownSecrets } = useWizardConfig(info, draft);
  const isPush = type === 'webhook-push';
  const mapped = fromRows(rows);
  const lifeError = lifecycleError(life);
  const sender = useWizardRecipe({ info, draft, setRows, setLife });
  const guide = useRecipeSetup(
    isPush ? ((draft.config.recipe as string | undefined) ?? 'custom') : undefined,
  );
  const origin: SecretOrigin =
    guide.data?.secret.origin ?? sender.recipe?.secretOrigin ?? 'passbook';
  const provider = guide.data?.provider.name ?? sender.recipe?.label.split(' ')[0] ?? 'Your system';
  const steps = isPush
    ? railSteps({ provider, origin, locked: false, summary: sender.recipe?.label })
    : [...PASSBOOK_STEPS];
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

  const catalog = connectors.data?.items;
  const tiles = useMemo(() => (catalog ? buildTiles(catalog) : []), [catalog]);
  const recipeNow = draft.config.recipe as string | undefined;
  const pickTile = (tile: ConnectorTile) => {
    if (tile.key === tileKey(type, recipeNow)) return;
    const hadSender = tileKey(type, recipeNow) !== type;
    setType(tile.type);
    setRestSample([]);
    setDraft((d) => ({
      ...d,
      config: tile.recipe ? { recipe: tile.recipe } : {},
      secrets: {},
      signingSecret: '',
    }));
    // A sender seeds the mapping, holder email and void rules; leaving one clears them.
    if (tile.recipe || hadSender) {
      const recipes = catalog?.find((c) => c.type === tile.type)?.recipes;
      sender.seed(recipes?.find((r) => r.id === tile.recipe));
    }
  };

  // A link names its source: pick it and start at Setup, the step after the one choice.
  const sourced = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the tiles arrive
  useEffect(() => {
    if (!source || sourced.current || type || tiles.length === 0) return;
    sourced.current = true;
    const tile = tiles.find((t) => t.key === (source === 'custom' ? 'webhook-push' : source));
    if (!tile) return;
    pickTile(tile);
    setStep(1);
  }, [tiles]);

  // Sending out is not a stored connection: its own steps open at the endpoint, on their own URL.
  const goOutbound = () =>
    void navigate({ to: '/admin/connections/new', search: { source: OUTBOUND }, replace: true });

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

  // The new connection's page replaces the wizard in history. A webhook goes on to its other side:
  // PassBook's secret waits in memory for the page that shows it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigate once per creation
  useEffect(() => {
    if (!created) return;
    if (created.secret) holdSecret(created.id, created.secret);
    if (isPush) {
      void navigate({
        to: '/admin/connections/$connectionId/setup',
        params: { connectionId: created.id },
        replace: true,
      });
      return;
    }
    markCreated(`connection:${created.id}`);
    void navigate({
      to: '/admin/connections/$connectionId',
      params: { connectionId: created.id },
      ...(created.secret ? { search: { tab: 'webhook' as const } } : {}),
      replace: true,
    });
  }, [created]);

  const currentCreate = create.variables?.scope === scopeToken;
  const serverFields = currentCreate && isApiError(create.error) ? create.error.fields : {};
  const crumbs = [{ label: 'Connections', to: '/admin/connections' }, { label: 'New' }];
  const noMappings = rows.length === 0;
  const blockCreate = life.autoCreate && (!life.defaultTemplateId || noMappings);

  /** False keeps the step: the Wizard focuses the first error and announces the count. */
  function next(): boolean {
    const invalid = Object.keys(cfgErrors).length + Object.keys(secErrors).length > 0;
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
    if (step === 0 && type === OUTBOUND) {
      goOutbound();
      return true;
    }
    if (step === REVIEW) {
      if (!blockCreate && orgId) create.mutate({ orgId, scope: scopeToken });
      return true;
    }
    setStep((s) => s + 1);
    return true;
  }

  const orgList = orgs.data?.items ?? [];
  const orgName = orgList.find((o) => o.id === orgId)?.name ?? '—';
  return (
    <>
      <PageHeader title="New connection" breadcrumbs={crumbs} />
      <Wizard
        steps={steps}
        current={step}
        onStep={setStep}
        aside={<WizardAside connector={info} sender={sender.recipe} sample={sample} step={step} />}
        asideLabel="Connector"
        onCancel={() => void navigate({ to: '/admin/connections' })}
        onBack={step > 0 ? () => setStep(step - 1) : undefined}
        onNext={next}
        nextLabel={step < REVIEW ? 'Next' : noMappings ? 'Create without mappings' : 'Create'}
        nextHint="Pick a connector."
        nextDisabled={(step === 0 && !type) || (step === REVIEW && blockCreate)}
        busy={(currentCreate && create.isPending) || Boolean(created)}
      >
        {step === 0 ? (
          <ConnectorStep
            tiles={tiles}
            loading={connectors.isPending}
            type={type}
            recipe={recipeNow}
            onPick={pickTile}
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
        <WizardBody
          step={step}
          info={info}
          connector={connector}
          orgId={orgId}
          orgName={orgName}
          draft={draft}
          setDraft={setDraft}
          showErrors={showErrors}
          serverFields={serverFields}
          test={test}
          onTested={onTested}
          life={life}
          setLife={setLife}
          lifeError={lifeError}
          templateOrg={templateOrg}
          selectedTemplateName={selectedTemplate?.name}
          rows={rows}
          setRows={setRows}
          mapped={mapped}
          sample={sample}
          targets={targets}
          cfgErrors={cfgErrors}
          defaultMinutes={defaultMinutes}
          blockCreate={blockCreate}
          createFailed={currentCreate && create.isError}
          createError={create.error}
          setStep={setStep}
          isUpload={isUpload}
          after={isPush ? provider : undefined}
          upload={upload}
          onSample={setRestSample}
        />
      </Wizard>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
