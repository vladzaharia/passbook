import { useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { errorMessage } from '../../../lib/errors.ts';
import { useMediaQuery } from '../../../lib/media.ts';
import { useSession } from '../../../lib/session.ts';
import { Callout, Card, CardHeader, ErrorState, Skeleton } from '../../../ui/index.ts';
import { useTemplate } from '../../templates/api.ts';
import { useCheckImport } from './api.ts';
import { useSavedMappings, useSaveMapping } from './api-run.ts';
import { ImportWizard, summaryOf } from './import-wizard.tsx';
import { MatchSettings, type MatchSettingsValue, RowCard } from './match-aside.tsx';
import {
  type MatchRow,
  type MatchState,
  planOfState,
  setColumns,
  shownRows,
  stateOfImport,
} from './match-model.ts';
import { MatchRows } from './match-rows.tsx';
import { MatchSummary, SavedPicker, UnusedColumns, valuesLeft } from './match-summary.tsx';
import { STEP } from './steps.ts';

function MatchForm({
  imp,
  orgId,
  schema,
  onChecked,
  onStep,
}: {
  imp: PassImportDto;
  orgId: string;
  schema: unknown;
  onChecked: () => void;
  onStep: (step: number) => void;
}) {
  const session = useSession();
  const wide = useMediaQuery('(min-width: 1024px)');
  const check = useCheckImport(imp.id, orgId);
  const saved = useSavedMappings(imp.templateId, orgId);
  const save = useSaveMapping(imp.templateId, orgId);
  const [state, setState] = useState<MatchState>(() => stateOfImport(imp, schema));
  const [settings, setSettings] = useState<MatchSettingsValue>({
    save: imp.plan?.save ?? true,
    name: '',
    keepManual: imp.plan?.keepManual ?? false,
  });
  const [shown, setShown] = useState(false);
  const result = planOfState(state, { ...settings, overrides: imp.plan?.overrides });
  const left = valuesLeft(state);

  const setRow = (row: MatchRow) =>
    setState((s) => ({ ...s, rows: s.rows.map((r) => (r.key === row.key ? row : r)) }));

  function use(rowKey: string, pointer: string) {
    const row = state.rows.find((r) => r.key === rowKey);
    if (!row) return;
    setState((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.key === rowKey ? setColumns(r, [pointer], imp.columns) : r)),
      unused: s.unused.filter((u) => u.pointer !== pointer),
    }));
  }

  function pick(name: string) {
    const hit = saved.data?.saved.find((s) => s.name === name);
    if (!hit) return;
    setState(stateOfImport({ ...imp, plan: hit.plan }, schema));
    setSettings((s) => ({ ...s, name: hit.name }));
  }

  function submit() {
    setShown(true);
    const plan = result.plan;
    if (!plan) return false;
    check.mutate(
      { plan },
      {
        onSuccess: () => {
          // A name makes it a saved mapping; the unnamed last plan is saved by the check itself.
          if (settings.save && settings.name.trim())
            save.mutate({
              name: settings.name.trim(),
              columns: imp.columns.map((c) => c.label),
              plan,
            });
          onChecked();
        },
      },
    );
    return undefined;
  }

  const aside = (
    <div className="flex flex-col gap-6">
      <RowCard imp={imp} orgId={orgId} principalId={session.authed?.user.id} state={state} />
      <MatchSettings
        state={state}
        value={settings}
        onState={setState}
        onValue={setSettings}
        matchError={shown ? result.matchError : undefined}
      />
    </div>
  );

  return (
    <ImportWizard
      current={STEP.match}
      summary={summaryOf(imp)}
      onStep={onStep}
      onCancel={() => onStep(STEP.source)}
      onBack={() => onStep(STEP.source)}
      onNext={submit}
      nextLabel={C.match.checkRows(imp.counts?.rows ?? null)}
      busy={check.isPending}
      asideLabel={C.match.rowCard}
      asideQuiet
      aside={aside}
    >
      <Card>
        <CardHeader
          title={C.match.title}
          actions={<SavedPicker saved={saved.data?.saved ?? []} onPick={pick} />}
        />
        {imp.errorCode && !check.isError ? (
          <Callout tone="warning" className="m-4">
            {errorText(imp.errorCode)}
          </Callout>
        ) : null}
        <MatchSummary state={state} columns={imp.columns.length} />
        <MatchRows
          rows={shownRows(state)}
          columns={imp.columns}
          state={state}
          errors={shown ? result.errors : {}}
          onRow={setRow}
        />
        <UnusedColumns state={state} onUse={use} />
      </Card>
      {wide ? null : (
        <Card>
          <div className="p-4">
            <MatchSettings
              state={state}
              value={settings}
              onState={setState}
              onValue={setSettings}
              matchError={shown ? result.matchError : undefined}
            />
          </div>
        </Card>
      )}
      {left > 0 ? <p className="text-xs text-fg-muted">{C.match.valuesLeft(left)}</p> : null}
      {check.isError ? <Callout tone="danger">{errorMessage(check.error)}</Callout> : null}
    </ImportWizard>
  );
}

const errorText = (code: string) =>
  code === 'IMPORT_COLUMN_MISSING' ? C.savedColumns : C.checkUnfinished;

/** Match the file's columns to the template's fields, then check. */
export function MatchStep({
  imp,
  orgId,
  onChecked,
  onStep,
}: {
  imp: PassImportDto;
  orgId: string;
  onChecked: () => void;
  onStep: (step: number) => void;
}) {
  const template = useTemplate(imp.templateId, orgId);
  if (template.isError)
    return (
      <ErrorState
        subject="the template"
        error={template.error}
        onRetry={() => template.refetch()}
      />
    );
  if (!template.data) return <Skeleton className="h-64" />;
  return (
    <MatchForm
      imp={imp}
      orgId={orgId}
      schema={template.data.inputSchema}
      onChecked={onChecked}
      onStep={onStep}
    />
  );
}
