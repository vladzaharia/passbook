import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { formatDay } from '../../lib/format.ts';
import { useMode } from '../../lib/mode.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
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
import { downloadText, toCsv } from './csv.ts';
import { PassListContext, passColumns } from './list-columns.tsx';
import { CLEARED, type ListSearch, PassListFilters } from './list-filters.tsx';
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
  const list = usePassList({ ...search, orgId });
  const templates = useTemplates({ orgId });
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
  const filtered = Object.values(search).some((v) => v !== undefined && v !== '');
  const truth = !list.isPending && !filtered && rows.length === 0;

  // A new filter, scope or mode is a new list: the selection does not carry over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the query key only
  useEffect(() => setSelected(new Set()), [orgId, mode, JSON.stringify(search)]);

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

  const toggle = useCallback(
    (id: string) =>
      setSelected((s) => {
        const next = new Set(s);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = useCallback(
    () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id))),
    [allSelected, rows],
  );

  const bundleOrgId = useMemo(() => {
    const orgs = new Set(rows.filter((r) => selected.has(r.id)).map((r) => r.orgId));
    return orgs.size === 1 ? ([...orgs][0] ?? null) : null;
  }, [rows, selected]);
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
    <Button asChild variant={variant} iconStart={<Plus aria-hidden />}>
      <Link to="/admin/passes/new">New pass</Link>
    </Button>
  );

  return (
    <div className={selected.size > 0 ? 'pb-20' : undefined}>
      <PageHeader
        title="Passes"
        actions={canOperate ? create(truth ? 'outline' : 'primary') : undefined}
      />
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
              <PassListFilters
                search={search}
                orgId={orgId}
                templates={templates.data?.items ?? []}
                onChange={onSearch}
              />
            }
            empty={
              <EmptyState
                art="passes"
                title="No passes yet"
                action={canOperate ? create('primary') : undefined}
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
        onClear={() => setSelected(new Set())}
        onExport={exportCsv}
      />
    </div>
  );
}
