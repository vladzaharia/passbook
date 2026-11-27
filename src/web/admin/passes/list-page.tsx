import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { ImagePlus, Plus, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PassFilter } from '@/shared/contracts/pass-selection.ts';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { isApiError } from '../../lib/errors.ts';
import { useMode } from '../../lib/mode.ts';
import { useAdminScope, useOrgScope } from '../../lib/org-filter.tsx';
import { readablePassOrgs } from '../../lib/org-lists.ts';
import { orgPath } from '../../lib/scope.ts';
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
import { BulkRunCard } from './bulk-run-card.tsx';
import { canChangePasses, filterSelection, leaveSelection } from './change/selection.ts';
import { useCurrentBulkRun } from './find-api.ts';
import { useFindFields } from './find-fields.ts';
import { allChips, chipFilter, toPassFilter } from './find-query.ts';
import { SelectAllBanner, SelectAllPhone } from './find-select.tsx';
import { orgIdsOf, PassFindToolbar } from './find-toolbar.tsx';
import { isFiltered, useAllScopeOrgIds, usePassList } from './list-api.ts';
import { PassListContext, passColumns } from './list-columns.tsx';
import { exportPassesCsv } from './list-export.ts';
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
  // The All scope lists every readable organization without edits; opening a row is the scope switch.
  const all = useAdminScope()?.kind === 'all';
  const readableIds = useAllScopeOrgIds(all);
  const returnTo = useRouterState({ select: (state) => state.location.href });
  const canRead = all
    ? readableIds.size >= 2
    : Boolean(
        !scope.isLoading &&
          !scope.isError &&
          orgId &&
          scope.membership?.capabilities.includes('passes:read'),
      );
  const canOperate =
    !all &&
    Boolean(
      !scope.isLoading &&
        !scope.isError &&
        orgId &&
        scope.membership?.capabilities.includes('passes:operate'),
    );
  const mode = useMode();
  const chips = useMemo(() => allChips(search), [search]);
  const orgIds = useMemo(() => orgIdsOf(search.orgIds), [search.orgIds]);
  const list = usePassList(
    { ...search, ...chipFilter(chips), orgId, orgIds },
    { kind: all ? 'all' : 'org' },
  );
  const templates = useTemplates({ orgId });
  const fields = useFindFields(templates.data?.items ?? [], search.templateId, orgId);
  const fieldLabels = useMemo(() => new Map(fields.map((f) => [f.key, f.label])), [fields]);
  const rows = useMemo(
    () =>
      canRead
        ? (list.data?.pages
            .flatMap((page) => page.items)
            .filter((pass) => (all ? readableIds.has(pass.orgId) : pass.orgId === orgId)) ?? [])
        : [],
    [canRead, list.data, orgId, all, readableIds],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [runId, setRunId] = useState<string>();
  const [dismissed, setDismissed] = useState<string>();
  const current = useCurrentBulkRun(orgId, canOperate);
  const shownRun =
    runId ?? (current.data && current.data.id !== dismissed ? current.data.id : undefined);
  const count = list.data?.pages[0]?.count ?? rows.length;
  const filtered = isFiltered(search, all);
  const truth = !list.isPending && !list.isError && !filtered && rows.length === 0;

  // A new filter, scope or mode is a new list: the selection does not carry over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the query key only
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [orgId, mode, JSON.stringify(search)]);

  const templateNames = useMemo(
    () =>
      new Map(
        all
          ? rows.flatMap((r) => (r.templateName ? [[r.templateId, r.templateName] as const] : []))
          : (templates.data?.items ?? []).map((t) => [t.id, t.name] as const),
      ),
    [all, rows, templates.data],
  );
  const readable = useMemo(
    () => (all ? readablePassOrgs(scope.memberships).filter((m) => readableIds.has(m.orgId)) : []),
    [all, scope.memberships, readableIds],
  );
  const orgs = useMemo(() => new Map(readable.map((m) => [m.orgId, m])), [readable]);
  const templateIds = useMemo(() => [...new Set(rows.map((r) => r.templateId))].sort(), [rows]);
  // Previews are per organization: the All list shows plain chips.
  const swatches = useSwatches(all ? [] : templateIds, orgId);
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
  const columns = useMemo(() => passColumns(all), [all]);
  const context = useMemo(
    () => ({
      orgId,
      canOperate,
      templateNames,
      all,
      orgs,
      returnTo,
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
      all,
      orgs,
      returnTo,
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
        <DataTable
          caption="Passes"
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          loading={list.isPending}
          error={
            list.isError ? (
              <ErrorState
                error={list.error}
                // Too many organizations: retrying cannot help; the Organization filter can.
                onRetry={
                  isApiError(list.error) && list.error.code === 'ORG_SCOPE_TOO_WIDE'
                    ? undefined
                    : () => void list.refetch()
                }
              />
            ) : undefined
          }
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
                all={all ? readable : undefined}
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
                all ? undefined : (
                  <OtherModeHint orgId={orgId} hidden={Boolean(scope.membership?.testOnly)} />
                )
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
        onExport={() =>
          exportPassesCsv(
            rows.filter((r) => selected.has(r.id)),
            templateNames,
          )
        }
        onChange={openChange}
        onRun={setRunId}
        all={allMatching ? { filter: toPassFilter({ ...search, chips }), count } : undefined}
      />
    </div>
  );
}
