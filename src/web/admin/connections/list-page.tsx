import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { z } from 'zod';
import type { ConnectionSummarySchema } from '@/shared/contracts/connections.ts';
import { connectorIcon } from '../../lib/entities.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useOrgOptions } from '../../lib/search.ts';
import {
  Button,
  CountLink,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  FilteredEmpty,
  LoadMore,
  PageHeader,
  RowLink,
} from '../../ui/index.ts';
import { useConnectionPages, useConnectorNames } from './api.ts';
import { HealthPill } from './health.tsx';
import { healthLine } from './health-text.ts';
import { HEALTH_FILTERS, modeLabel } from './labels.ts';
import { showLive, TestModeNote } from './test-mode-note.tsx';

type Connection = z.infer<typeof ConnectionSummarySchema>;
const ALL = 'all';

export interface ConnectionListSearch {
  q?: string | undefined;
  health?: string | undefined;
}

export function ConnectionsListPage({
  search,
  onSearch,
}: {
  search: ConnectionListSearch;
  onSearch: (patch: Partial<ConnectionListSearch>) => void;
}) {
  const { orgId } = useOrgScope();
  const orgs = useOrgOptions();
  const connectorName = useConnectorNames();
  const [text, setText] = useState(search.q ?? '');
  useEffect(() => setText(search.q ?? ''), [search.q]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === (search.q ?? '')) return;
    const t = setTimeout(() => onSearch({ q: trimmed || undefined }), 300);
    return () => clearTimeout(t);
  }, [text, search.q, onSearch]);
  const list = useConnectionPages({ orgId, health: search.health, q: search.q });
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const filtered = Boolean(search.q || search.health);
  const orgNames = useMemo(
    () => new Map((orgs.data?.items ?? []).map((o) => [o.id, o.name])),
    [orgs.data],
  );
  const columns = useMemo<ColumnDef<Connection, never>[]>(() => {
    const now = Date.now();
    return [
      {
        id: 'name',
        header: 'Connection',
        cell: ({ row }) => (
          <div className="min-w-0 max-w-72">
            <RowLink
              to="/admin/connections/$connectionId"
              params={{ connectionId: row.original.id }}
            >
              {row.original.name}
            </RowLink>
            {orgId ? null : (
              <span
                className="block truncate text-xs text-fg-muted"
                title={orgNames.get(row.original.orgId)}
              >
                {orgNames.get(row.original.orgId) ?? '—'}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        meta: { nowrap: true },
        cell: ({ row }) => {
          const Icon = connectorIcon(row.original.connectorType);
          return (
            <span className="inline-flex items-center gap-2">
              <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" />
              {connectorName(row.original.connectorType)} · {modeLabel(row.original.mode)}
            </span>
          );
        },
      },
      {
        id: 'health',
        header: 'Health',
        cell: ({ row }) => {
          const line = healthLine(row.original, now);
          return (
            <div className="flex min-w-0 max-w-64 flex-col items-start gap-0.5">
              <HealthPill health={row.original.enabled ? row.original.health : 'disabled'} />
              {line ? (
                <span
                  className="block max-w-full truncate text-xs leading-3 text-fg-muted"
                  title={line}
                >
                  {line}
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'passes',
        header: 'Passes',
        meta: { numeric: true },
        cell: ({ row }) => (
          <CountLink
            count={row.original.passCount}
            to="/admin/passes"
            search={{ connectionId: row.original.id }}
            onClick={showLive}
            aria-label={`${row.original.passCount} passes from ${row.original.name}`}
          />
        ),
      },
      {
        id: 'last',
        header: 'Last success',
        meta: { nowrap: true, hideBelow: 'lg', stackHidden: true },
        cell: ({ row }) => formatDateTime(row.original.lastSuccessAt, '—'),
      },
    ];
  }, [orgNames, connectorName, orgId]);

  const clear = () => {
    setText('');
    onSearch({ q: undefined, health: undefined });
  };
  const empty = !list.isPending && rows.length === 0 && !filtered;
  const create = (variant: 'primary' | 'outline') => (
    <Button asChild variant={variant} iconStart={<Plus aria-hidden />}>
      <Link to="/admin/connections/new">New connection</Link>
    </Button>
  );

  return (
    <>
      <PageHeader title="Connections" actions={create(empty ? 'outline' : 'primary')} />
      <TestModeNote className="mb-4" />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption="Connections"
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          loading={list.isPending}
          fetching={list.isFetching && !list.isFetchingNextPage}
          filtered={filtered}
          toolbar={
            <FilterBar
              search={{ value: text, onChange: setText, placeholder: 'Search connections' }}
              filters={[
                {
                  id: 'health',
                  label: 'Health',
                  value: search.health ?? ALL,
                  defaultValue: ALL,
                  options: [
                    { value: ALL, label: 'All' },
                    ...HEALTH_FILTERS.map(([value, label]) => ({ value, label })),
                  ],
                  onChange: (v) => onSearch({ health: v === ALL ? undefined : v }),
                },
              ]}
              onClear={clear}
            />
          }
          emptyFiltered={<FilteredEmpty entity="connection" onClear={clear} />}
          empty={<EmptyState art="plugs" title="No connections" action={create('primary')} />}
          footer={
            <LoadMore
              query={list}
              shown={rows.length || undefined}
              noun={['connection', 'connections']}
              scoped
            />
          }
        />
      )}
    </>
  );
}
