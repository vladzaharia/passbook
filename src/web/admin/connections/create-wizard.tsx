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
import { buildTiles, type ConnectorTile, tileKey } from './connector-tiles.ts';
import { CreatedStep } from './created-step.tsx';
import { takeConnectionPrefill, wizardStart } from './import-handoff.ts';
import { type Lifecycle, lifecycleError } from './lifecycle-fields.tsx';
import { TestModeNote } from './test-mode-note.tsx';
import { useConnectionCreation } from './use-connection-creation.ts';
import { useWizardRecipe } from './use-wizard-recipe.ts';
import { WizardBody } from './wizard-body.tsx';
import { useWizardConfig } from './wizard-config.ts';
import { WizardAside } from './wizard-review.tsx';
import type { ConfigDraft } from './wizard-steps.tsx';
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

  const dirty = !created && (Boolean(type) || draft.name !== '' || rows.length > 0);
  const guard = useUnsavedChangesGuard(dirty);

  const info = connector.data;
  const { cfgErrors, secErrors, shownSecrets } = useWizardConfig(info, draft);
  const mapped = fromRows(rows);
  const lifeError = lifecycleError(life);
  const sender = useWizardRecipe({ info, draft, setRows, setLife });
  const sample =
    test?.kind === 'result' && test.result.sample
      ? test.result.sample
      : Object.keys(sender.recipe?.outputFields ?? info?.outputFields ?? {}).map((k) => ({
          pointer: `/${k}`,
        }));
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
  const tiles = useMemo(() => buildTiles(catalog ?? []), [catalog]);
  const recipeNow = draft.config.recipe as string | undefined;
  const pickTile = (tile: ConnectorTile) => {
    if (tile.key === tileKey(type, recipeNow)) return;
    const hadSender = tileKey(type, recipeNow) !== type;
    setType(tile.type);
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

  const create = useConnectionCreation({
    currentScope,
    life,
    type,
    draft,
    shownSecrets,
    mapping: mapped.mapping,
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
      (step === 1 && (!draft.name.trim() || invalid)) ||
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
      <TestModeNote className="mb-4" />
      <Wizard
        steps={STEPS}
        current={step}
        onStep={setStep}
        aside={<WizardAside connector={info} sender={sender.recipe} sample={sample} step={step} />}
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
          secretError={sender.secretError}
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
          noMappings={noMappings}
          defaultMinutes={defaultMinutes}
          blockCreate={blockCreate}
          createFailed={currentCreate && create.isError}
          createError={create.error}
          setStep={setStep}
        />
      </Wizard>
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
