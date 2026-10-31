import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Ticket } from 'lucide-react';
import { useMemo } from 'react';
import type { PassSummaryDto } from '@/shared/contracts/passes.ts';
import { useOrgFilter } from '../../lib/org-filter.tsx';
import {
  Button,
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  IconButton,
  LoadMore,
  PageHeader,
  StatusPill,
  toast,
} from '../../ui/index.ts';
import { useTemplates } from '../templates/api.ts';
import { usePassActions, usePassList } from './api.ts';
import { formatDate } from './format.ts';
import { type ListSearch, PassListFilters } from './list-filters.tsx';

function RowActions({ pass }: { pass: PassSummaryDto }) {
  const actions = usePassActions(pass.id);
  const voided = pass.status === 'voided';
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
    } catch (error) {
      toast.error(error);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={`Actions for ${pass.title ?? pass.serial}`}
          icon={<MoreHorizontal aria-hidden />}
          onClick={(e) => e.stopPropagation()}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          onSelect={() =>
            run(
              () => actions.setVoided.mutateAsync(!voided),
              voided ? 'Pass unvoided' : 'Pass voided',
            )
          }
        >
          {voided ? 'Unvoid' : 'Void'}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!pass.connectionId}
          onSelect={() => run(() => actions.refreshFromSource.mutateAsync(), 'Refresh requested')}
        >
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PassesListPage({
  search,
  onSearch,
}: {
  search: ListSearch;
  onSearch: (patch: Partial<ListSearch>) => void;
}) {
  const { orgId: globalOrg } = useOrgFilter();
  const effective: ListSearch = { ...search, orgId: search.orgId ?? globalOrg };
  const list = usePassList(effective);
  const templates = useTemplates({ orgId: effective.orgId });
  const names = useMemo(
    () => new Map((templates.data?.items ?? []).map((t) => [t.id, t.name])),
    [templates.data],
  );
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const columns = useMemo<ColumnDef<PassSummaryDto, never>[]>(
    () => [
      {
        id: 'title',
        header: 'Pass',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="min-w-0">
            <Link
              to={`/admin/passes/${row.original.id}` as never}
              className="font-medium text-accent-fg hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.title ?? row.original.serial}
            </Link>
            {row.original.subtitle ? (
              <p className="truncate text-xs text-fg-muted">{row.original.subtitle}</p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'holder',
        header: 'Holder',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={row.original.holderState} />
            {row.original.holderEmail ? (
              <span className="text-xs text-fg-muted">{row.original.holderEmail}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <StatusPill status={row.original.status} />
            {row.original.syncErrorCode ? (
              <StatusPill status="failing" tone="danger">
                {row.original.syncErrorCode}
              </StatusPill>
            ) : null}
          </div>
        ),
      },
      {
        id: 'template',
        header: 'Template',
        enableSorting: false,
        cell: ({ row }) => names.get(row.original.templateId) ?? row.original.templateId,
      },
      {
        id: 'modified',
        header: 'Modified',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-fg-muted">
            v{row.original.version} · {formatDate(row.original.modifiedAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => <RowActions pass={row.original} />,
      },
    ],
    [names],
  );

  const filtered = Object.values(search).some(Boolean);

  return (
    <>
      <PageHeader
        title="Passes"
        actions={
          <Button asChild iconStart={<Plus aria-hidden />}>
            <Link to="/admin/passes/new">New pass</Link>
          </Button>
        }
      />
      <PassListFilters search={effective} onChange={onSearch} />
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <>
          <DataTable
            caption="Passes"
            columns={columns}
            data={rows}
            getRowId={(r) => r.id}
            loading={list.isPending}
            virtualHeight={640}
            rowHeight={56}
            empty={
              <EmptyState
                icon={Ticket}
                title={filtered ? 'No passes match' : 'No passes yet'}
                action={
                  filtered ? undefined : (
                    <Button asChild>
                      <Link to="/admin/passes/new">New pass</Link>
                    </Button>
                  )
                }
              />
            }
          />
          <LoadMore
            hasMore={Boolean(list.hasNextPage)}
            loading={list.isFetchingNextPage}
            onLoadMore={() => void list.fetchNextPage()}
            shown={rows.length || undefined}
          />
        </>
      )}
    </>
  );
}
