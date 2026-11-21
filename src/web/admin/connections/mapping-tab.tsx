import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionDetailSchema } from '@/shared/contracts/connections.ts';
import { ACTION_ICON } from '../../lib/action-icons.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  SaveBar,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from '../../ui/index.ts';
import { fromRows, type MappingRow, type SourceField, toRows } from '../mapping/mapping.ts';
import { MappingEditor, targetsOf } from '../mapping/mapping-editor.tsx';
import {
  type MatchRow,
  type MatchState,
  setColumns,
  shownRows,
} from '../passes/import/match-model.ts';
import { MatchRowView } from '../passes/import/match-rows.tsx';
import { MatchSummary, UnusedColumns } from '../passes/import/match-summary.tsx';
import { describeSchema, flatFields } from '../passes/schema-form/index.ts';
import { useTemplate } from '../templates/api.ts';
import { useConnectionActions, useConnector } from './api.ts';
import { FirstSync } from './first-sync.tsx';
import { columnsOf, mapOfState, stateOfConnection } from './map-model.ts';
import { TemplateSelect } from './template-select.tsx';

type Detail = z.infer<typeof ConnectionDetailSchema>;

/** The template's fields over the source's: rows like an import's, and a dry run of the first sync beside them. */
export function MappingTab({
  c,
  canManage,
  sample,
  onLoadSample,
  loadingSample,
}: {
  c: Detail;
  canManage: boolean;
  sample: readonly SourceField[] | undefined;
  onLoadSample: () => void;
  loadingSample: boolean;
}) {
  const actions = useConnectionActions(c.id);
  const connector = useConnector(c.connectorType, c.orgId);
  const original = useMemo(() => JSON.stringify(c.mapping ?? {}), [c.mapping]);
  const [templateId, setTemplateId] = useState(c.defaultTemplateId ?? '');
  const scope = useOrgScope();
  const templateOrg =
    scope.orgId === c.orgId && scope.membership?.capabilities.includes('templates:read')
      ? c.orgId
      : undefined;
  const template = useTemplate(templateOrg ? templateId || undefined : undefined, templateOrg);
  const schema =
    templateOrg &&
    template.data &&
    (template.data.orgId === null || template.data.orgId === c.orgId)
      ? template.data.inputSchema
      : undefined;
  const dry = actions.preview.data?.ok ? actions.preview.data : undefined;

  const [rows, setRows] = useState<MappingRow[]>(() => toRows(c.mapping));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [shown, setShown] = useState(false);
  const baseKey = `${templateId}|${actions.preview.submittedAt}`;
  const base = useMemo(
    () => (dry && schema && dry.columns.length ? stateOfConnection(c, dry, schema) : null),
    [c, dry, schema],
  );
  const [edits, setEdits] = useState<{ key: string; state: MatchState } | null>(null);
  const match = base ? (edits?.key === baseKey ? edits.state : base) : null;
  const matched = match ? mapOfState(match, c) : null;
  const edited = edits?.key === baseKey;
  const saved = Object.keys(c.mapping ?? {}).length > 0;

  const result = fromRows(rows);
  const tplChanged = templateId !== (c.defaultTemplateId ?? '');
  const dirty = match
    ? edited || tplChanged || (!saved && Object.keys(matched?.mapping ?? {}).length > 0)
    : JSON.stringify(result.mapping) !== original ||
      Object.keys(result.errors).length > 0 ||
      tplChanged;
  const guard = useUnsavedChangesGuard(canManage && dirty);
  const sources: readonly SourceField[] = dry
    ? dry.columns.map((x) => ({ pointer: x.pointer }))
    : (sample ??
      Object.keys(connector.data?.outputFields ?? {}).map((k) => ({ pointer: `/${k}` })));

  const setState = (next: MatchState) => match && setEdits({ key: baseKey, state: next });
  const setRow = (row: MatchRow) =>
    match && setState({ ...match, rows: match.rows.map((r) => (r.key === row.key ? row : r)) });
  const use = (rowKey: string, pointer: string) => {
    const row = match?.rows.find((r) => r.key === rowKey);
    if (!match || !row || !dry) return;
    setState({
      ...match,
      rows: match.rows.map((r) =>
        r.key === rowKey ? setColumns(r, [pointer], columnsOf(dry)) : r,
      ),
      unused: match.unused.filter((u) => u.pointer !== pointer),
    });
  };

  async function save() {
    if (!canManage) return;
    const tpl =
      templateId && templateId !== c.defaultTemplateId ? { defaultTemplateId: templateId } : {};
    try {
      if (matched) {
        setShown(true);
        if (Object.keys(matched.errors).length > 0) return;
        await actions.update.mutateAsync({
          mapping: matched.mapping,
          ...(JSON.stringify(matched.voidWhen) === JSON.stringify(c.voidWhen)
            ? {}
            : { voidWhen: matched.voidWhen }),
          ...(matched.holderEmailField && matched.holderEmailField !== c.holderEmailField
            ? { holderEmailField: matched.holderEmailField }
            : {}),
          ...tpl,
        });
      } else {
        setErrors(result.errors);
        if (Object.keys(result.errors).length > 0) return;
        await actions.update.mutateAsync({ mapping: result.mapping, ...tpl });
      }
      toast.success('Mapping saved');
    } catch (error) {
      toast.error(error, 'Could not save');
    }
  }

  const mapCard = (
    <Card>
      <CardHeader
        title="Mapping"
        actions={
          canManage && !match ? (
            <Button
              variant="ghost"
              size="sm"
              busy="pulse"
              loading={loadingSample}
              iconStart={<ACTION_ICON.test aria-hidden />}
              onClick={onLoadSample}
            >
              {sample ? 'New sample' : 'Load sample'}
            </Button>
          ) : undefined
        }
      />
      <CardBody className="flex flex-col gap-4">
        <TemplateSelect
          orgId={c.orgId}
          value={templateId}
          disabled={!canManage || !templateOrg || actions.update.isPending}
          onChange={setTemplateId}
        />
        {match && dry ? null : (
          <MappingEditor
            rows={rows}
            onChange={setRows}
            errors={errors}
            targets={schema ? targetsOf(flatFields(describeSchema(schema))) : []}
            sources={sources}
            disabled={!canManage || actions.update.isPending}
          />
        )}
      </CardBody>
      {match && dry ? (
        <>
          <MatchSummary state={match} columns={dry.columns.length} />
          <ul className="@container wl-stagger border-t border-border">
            {shownRows(match).map((row, i) => (
              <MatchRowView
                key={row.key}
                row={row}
                columns={columnsOf(dry)}
                state={match}
                index={i}
                canSkip
                error={shown ? matched?.errors[row.key] : undefined}
                onRow={setRow}
              />
            ))}
          </ul>
          <UnusedColumns state={match} onUse={use} />
        </>
      ) : null}
      {canManage ? (
        <SaveBar
          dirty={dirty}
          saving={actions.update.isPending}
          paused={actions.update.isPaused}
          onSave={() => void save()}
          onDiscard={() => {
            setRows(toRows(c.mapping));
            setTemplateId(c.defaultTemplateId ?? '');
            setErrors({});
            setEdits(null);
            setShown(false);
          }}
        />
      ) : null}
      <UnsavedChangesDialog blocker={guard} />
    </Card>
  );

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
      {mapCard}
      <Card>
        <CardBody>
          <FirstSync
            preview={actions.preview.data}
            pending={actions.preview.isPending}
            error={actions.preview.error}
            templateId={templateId || null}
            orgId={c.orgId}
            canRun={canManage && c.enabled}
            onRun={() => actions.preview.mutate()}
          />
        </CardBody>
      </Card>
    </div>
  );
}
