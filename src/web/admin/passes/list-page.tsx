import { Link, useNavigate } from '@tanstack/react-router';
import { ImagePlus, Plus, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PassFilter } from '@/shared/contracts/pass-selection.ts';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { formatDay } from '../../lib/format.ts';
import { useMode } from '../../lib/mode.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { orgPath } from '../../lib/scope.ts';
import { useOrgOptions } from '../../lib/search.ts';
import { humanizeStatus } from '../../lib/status.ts';
import { useSwatches } from '../../lib/swatches.ts';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilteredEmpty,
  LoadMore,
  PageHeader,
} from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';
import { usePassList } from './api.ts';
import { BulkRunCard } from './bulk-run-card.tsx';
import { canChangePasses, filterSelection, leaveSelection } from './change/selection.ts';
import { downloadText, toCsv } from './csv.ts';
import { useCurrentBulkRun } from './find-api.ts';
import { useFindFields } from './find-fields.ts';
import { allChips, chipFilter, toPassFilter } from './find-query.ts';
import { SelectAllBanner, SelectAllPhone } from './find-select.tsx';
import { PassFindToolbar } from './find-toolbar.tsx';
import { PassListContext, passColumns } from './list-columns.tsx';
import { CLEARED, type ListSearch } from './list-filters.tsx';
import { OtherModeHint } from './other-mode-hint.tsx';
import { SelectionBar } from './selection-bar.tsx';
import './passes.css';

/** Small lists render plainly; the window only pays off for long ones. */
const VIRTUALIZE_ABOVE = 100;

export function PassesListPage({
  search,
  onSearch,
}: {
  search: ListSearch;
  onSearch: (patch: Partial<ListSearch>) => void;
}) {
  const scope = useOrgScope();
  const { orgId } = scope;
  const canRead = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      orgId &&
      scope.membership?.capabilities.includes('passes:read'),
  );
  const canOperate = Boolean(
    !scope.isLoading &&
      !scope.isError &&
      orgId &&
      scope.membership?.capabilities.includes('passes:operate'),
  );
  const mode = useMode();
  const chips = useMemo(() => allChips(search), [search]);
  const list = usePassList({ ...search, ...chipFilter(chips), orgId });
  const templates = useTemplates({ orgId });
  const fields = useFindFields(templates.data?.items ?? [], search.templateId, orgId);
  const fieldLabels = useMemo(() => new Map(fields.map((f) => [f.key, f.label])), [fields]);
  const orgs = useOrgOptions(!orgId);
  const rows = useMemo(
    () =>
      canRead
        ? (list.data?.pages.flatMap((page) => page.items).filter((pass) => pass.orgId === orgId) ??
          [])
        : [],
    [canRead, list.data, orgId],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [dismissed, setDismissed] = useState<string>();
  const current = useCurrentBulkRun(orgId, canOperate);
  const shownRun =
    runId ?? (current.data && current.data.id !== dismissed ? current.data.id : undefined);
  const count = list.data?.pages[0]?.count ?? rows.length;
  const filtered = Object.values(search).some((v) => v !== undefined && v !== '');
  const truth = !list.isPending && !filtered && rows.length === 0;

  // A new filter, scope or mode is a new list: the selection does not carry over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the query key only
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [orgId, mode, JSON.stringify(search)]);

  const templateNames = useMemo(
    () => new Map((templates.data?.items ?? []).map((t) => [t.id, t.name])),
    [templates.data],
  );
  const orgNames = useMemo(
    () => new Map((orgs.data?.items ?? []).map((o) => [o.id, o.name])),
    [orgs.data],
  );
  const templateIds = useMemo(() => [...new Set(rows.map((r) => r.templateId))].sort(), [rows]);
  const swatches = useSwatches(templateIds, orgId);
  const showSubtitles = useMemo(() => {
    const seen = new Set<string>();
    return rows.some((r) => {
      const t = r.title ?? r.serial;
      if (seen.has(t)) return true;
      seen.add(t);
      return false;
    });
  }, [rows]);

  // Unticking a row after "Select all matching" drops back to the ticked rows: the person's intent wins.
  const toggle = useCallback((id: string) => {
    setAllMatching(false);
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = useCallback(() => {
    setAllMatching(false);
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }, [allSelected, rows]);

  const bundleOrgId = useMemo(() => {
    const orgs = new Set(rows.filter((r) => selected.has(r.id)).map((r) => r.orgId));
    return orgs.size === 1 ? ([...orgs][0] ?? null) : null;
  }, [rows, selected]);
  const navigate = useNavigate();
  const openChange =
    orgId && canChangePasses(scope.membership?.capabilities)
      ? (passes: PassSummaryDto[], all?: { filter: PassFilter; count: number }) => {
          const templateIds = [...new Set(passes.map((p) => p.templateId))];
          const chosen = all
            ? filterSelection(all.filter, templateIds, all.count)
            : ({ kind: 'ids', ids: passes.map((p) => p.id), templateIds } as const);
          if (!chosen) return;
          leaveSelection(orgId, chosen);
          void navigate({ href: orgPath(orgId, '/passes/change') });
        }
      : undefined;
  const columns = useMemo(() => passColumns(!orgId), [orgId]);
  const context = useMemo(
    () => ({
      orgId,
      canOperate,
      templateNames,
      orgNames,
      swatches,
      showSubtitles,
      selected,
      allSelected,
      onToggle: toggle,
      onToggleAll: toggleAll,
      find: { chips, labels: fieldLabels },
    }),
    [
      orgId,
      canOperate,
      templateNames,
      orgNames,
      swatches,
      showSubtitles,
      selected,
      allSelected,
      toggle,
      toggleAll,
      chips,
      fieldLabels,
    ],
  );

  function exportCsv() {
    const chosen = rows.filter((r) => selected.has(r.id));
    const header = [
      'Pass',
      'Holder',
      'Holder state',
      ...(orgId ? [] : ['Organization']),
      'Template',
      'On device',
      'Updated',
    ];
    const line = (r: PassSummaryDto) => [
      r.title ?? r.serial,
      r.holderEmail ?? '',
      humanizeStatus(r.holderState),
      ...(orgId ? [] : [orgNames.get(r.orgId) ?? '']),
      templateNames.get(r.templateId) ?? '',
      String(r.deviceCount),
      formatDay(r.modifiedAt, ''),
    ];
    downloadText('passes.csv', toCsv(header, chosen.map(line)));
  }

  const create = (variant: 'primary' | 'outline') => (
    <>
      <Button asChild variant="outline" iconStart={<Upload aria-hidden />}>
        <Link to="/admin/passes/import">Import</Link>
      </Button>
      <Button asChild variant="outline" iconStart={<ImagePlus aria-hidden />}>
        <Link to="/admin/passes/photos">Photos</Link>
      </Button>
      <Button asChild variant={variant} iconStart={<Plus aria-hidden />}>
        <Link to="/admin/passes/new">New pass</Link>
      </Button>
    </>
  );

  return (
    <div className={selected.size > 0 || allMatching ? 'pb-20' : undefined}>
      <PageHeader title="Passes" actions={canOperate && !truth ? create('primary') : undefined} />
      {shownRun ? (
        <BulkRunCard
          id={shownRun}
          orgId={orgId}
          onDismiss={() => {
            setDismissed(shownRun);
            setRunId(undefined);
          }}
        />
      ) : null}
      <PassListContext.Provider value={context}>
        {list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <DataTable
            caption="Passes"
            columns={columns}
            data={rows}
            getRowId={(r) => r.id}
            loading={list.isPending}
            fetching={list.isFetching && !list.isFetchingNextPage}
            virtualHeight={rows.length > VIRTUALIZE_ABOVE ? 640 : undefined}
            filtered={filtered}
            toolbar={
              <>
                <PassFindToolbar
                  search={search}
                  orgId={orgId}
                  templates={templates.data?.items ?? []}
                  canOperate={canOperate}
                  onChange={onSearch}
                />
                {canOperate && !allSelected && rows.length > 0 ? (
                  <SelectAllPhone onSelect={toggleAll} />
                ) : null}
                {canOperate && allSelected ? (
                  <SelectAllBanner
                    count={count}
                    shown={rows.length}
                    all={allMatching}
                    onAll={() => setAllMatching(true)}
                    onClear={() => {
                      setAllMatching(false);
                      setSelected(new Set());
                    }}
                  />
                ) : null}
              </>
            }
            empty={
              <EmptyState
                art="passes"
                title="No passes yet"
                description={
                  <OtherModeHint orgId={orgId} hidden={Boolean(scope.membership?.testOnly)} />
                }
                action={
                  canOperate ? (
                    <div className="flex flex-wrap justify-center gap-2 max-sm:flex-col max-sm:[&>*]:w-full">
                      {create('primary')}
                    </div>
                  ) : undefined
                }
              />
            }
            emptyFiltered={<FilteredEmpty entity="pass" onClear={() => onSearch(CLEARED)} />}
            footer={
              <LoadMore
                query={list}
                shown={rows.length || undefined}
                noun={['pass', 'passes']}
                scoped
              />
            }
          />
        )}
      </PassListContext.Provider>
      <SelectionBar
        picked={rows.filter((r) => selected.has(r.id))}
        orgId={orgId}
        canOperate={canOperate}
        bundleOrgId={bundleOrgId}
        onClear={() => {
          setAllMatching(false);
          setSelected(new Set());
        }}
        onExport={exportCsv}
        onChange={openChange}
        onRun={setRunId}
        all={allMatching ? { filter: toPassFilter({ ...search, chips }), count } : undefined}
      />
    </div>
  );
}
